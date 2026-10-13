/**
 * The Properties palette's solid branch (src/ui/properties.ts `renderSolids`) over a minimal fake
 * DOM: the rows it shows for a selected solid and the name / layer edits it makes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { PropertiesPalette as PaletteType } from '../src/ui/properties';
import { model3dOf } from '../src/model3d/model';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';

const g = globalThis as Record<string, unknown>;
let Editor: typeof EditorType;
let PropertiesPalette: typeof PaletteType;
let installExperimental3d: typeof import('../src/app/experimental-3d').installExperimental3d;
let uninstall: () => void = () => {};
beforeAll(async () => {
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  uninstall = installFakeDocument();
  Editor = (await import('../src/app/editor')).Editor;
  ({ PropertiesPalette } = await import('../src/ui/properties'));
  ({ installExperimental3d } = await import('../src/app/experimental-3d'));
});
afterAll(async () => {
  uninstall();
  const { RIBBON } = await import('../src/ui/ribbon');
  const i = RIBBON.findIndex((t) => t.name === '3D');
  if (i >= 0) RIBBON.splice(i, 1);
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;

/** Label / value pairs of the palette's rows, plus headers and sections as single strings. */
function rows(body: FakeElement): Array<string | [string, FakeElement]> {
  return body.children.map((el) => (el.classes.has('prop-row') ? [el.children[0]!.textContent, el.children[1]!] : el.textContent));
}

describe('Properties palette: solids', () => {
  it('shows type, layer, colour, name and the read-only geometry; name and layer edits are undoable', () => {
    const ed = new Editor(canvas());
    ed.settings = { ...ed.settings, experimental3d: true };
    installExperimental3d(ed);
    void ed.runCommand('BOX');
    for (const t of ['0,0', '10,5', '3']) ed.submitInput(t);
    const id = model3dOf(ed.doc.snapshot).solids[0]!.id;
    const container = new FakeElement('div');
    const palette = new PropertiesPalette(ed, container as unknown as HTMLElement);
    palette.toggle();
    ed.selection = new Set([id]);
    ed.notify('selection');
    const body = container.children[0]!.children[1]!;
    const r = rows(body);
    const value = (label: string) => {
      const row = r.find((x): x is [string, FakeElement] => Array.isArray(x) && x[0] === label);
      return row?.[1];
    };
    expect(r[0]).toBe('3D Solid');
    // Milestone 4 adds the editable Parameters section (docs/3D-EDITING.md).
    expect(r.filter((x) => typeof x === 'string')).toEqual(['3D Solid', 'General', 'Parameters', 'Geometry']);
    expect(r.filter(Array.isArray).map((x) => x[0])).toEqual(['Type', 'Layer', 'Color', 'Name', 'Width', 'Depth', 'Height', 'Triangles', 'Volume', 'Size X', 'Size Y', 'Size Z']);
    expect(value('Width')!.value).toBe('10.0000');
    expect(value('Type')!.textContent).toBe('Box');
    expect(value('Volume')!.textContent).toBe('150.0000');
    expect(value('Size X')!.textContent).toBe('10.0000');
    expect(value('Triangles')!.textContent).toBe('12');
    // Edit the name, then the layer: each is one undo step on the solid.
    const name = value('Name')!;
    name.value = 'Base plate';
    name.fire('change');
    expect(model3dOf(ed.doc.snapshot).solids[0]!.name).toBe('Base plate');
    const layer = value('Layer')!;
    layer.value = 'MISC';
    layer.fire('change');
    expect(model3dOf(ed.doc.snapshot).solids[0]).toMatchObject({ id, layer: 'MISC', name: 'Base plate' });
    ed.doc.undo();
    expect(model3dOf(ed.doc.snapshot).solids[0]).toMatchObject({ layer: '0', name: 'Base plate' });
    ed.doc.undo();
    expect(model3dOf(ed.doc.snapshot).solids[0]!.name).toBeUndefined();
    // A parameter edit re-evaluates the box under the same id; a refused value changes nothing.
    const row = (label: string) => rows(container.children[0]!.children[1]!).find((x): x is [string, FakeElement] => Array.isArray(x) && x[0] === label)![1];
    const width = row('Width');
    width.value = '4';
    width.fire('change');
    expect(model3dOf(ed.doc.snapshot).solids[0]).toMatchObject({ id, feature: { width: 4 } });
    expect(row('Volume').textContent).toBe('60.0000');
    const before = ed.doc.snapshot;
    const bad = row('Width');
    bad.value = '-2';
    bad.fire('change');
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.history.at(-1)).toBe('PROPERTIES: Width must be positive and finite (got -2). The solid is unchanged.');
    expect(row('Width').value).toBe('4.0000');
  });
});
