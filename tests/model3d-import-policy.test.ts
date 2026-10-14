import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { Editor as EditorType } from '../src/app/editor';
import { normalizeSettings } from '../src/app/settings';
import { readDxf, writeDxf } from '../src/io/dxf';
import { model3dDwgRefusal } from '../src/model3d/save-guard';
import { meshVolume } from '../src/model3d/mesh';
import type { Model3D } from '../src/model3d/types';

let Editor: typeof EditorType;
beforeAll(async () => {
  const globals = globalThis as Record<string, unknown>;
  globals.requestAnimationFrame = () => 1;
  globals.cancelAnimationFrame = () => {};
  Editor = (await import('../src/app/editor')).Editor;
});
const canvas = () => ({ getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 }) as unknown as HTMLCanvasElement;
function editor(preferences: unknown = {}) {
  const ed = new Editor(canvas());
  ed.settings = normalizeSettings(preferences);
  return ed;
}
// Each fresh import has a new graph scope; its source handles and authored identities remain exact.
function content(model: Model3D | undefined) {
  return model && {
    ...model,
    solids: model.solids.map(solid => ({ ...solid, cadIdentity: solid.cadIdentity?.split(':').at(-1) })),
    ...(model.dimensions ? { dimensions: model.dimensions.map(dimension => ({ ...dimension, cadIdentity: dimension.cadIdentity?.split(':').at(-1) })) } : {}),
  };
}
function expectContent(actual: Model3D | undefined, expected: Model3D | undefined) {
  const left = JSON.stringify(content(actual)), right = JSON.stringify(content(expected));
  if (left !== right) {
    let index = 0;
    while (index < Math.min(left.length, right.length) && left[index] === right[index]) index++;
    throw new Error(`Model content differs at ${index}: actual ${left.slice(Math.max(0, index - 60), index + 120)}; expected ${right.slice(Math.max(0, index - 60), index + 120)}`);
  }
}
type Pair = [number, string | number];
const vertex = (x: number, y: number, z: number): Pair[] => [[0, 'VERTEX'], [8, '0'], [10, x], [20, y], [30, z], [70, 192]];
const face = (...indices: number[]): Pair[] => [[0, 'VERTEX'], [8, '0'], [10, 0], [20, 0], [30, 0], [70, 128], ...indices.map((index, i): Pair => [71 + i, index])];
const foreign = ([
  [0, 'SECTION'], [2, 'ENTITIES'], [0, 'POLYLINE'], [5, 'A1'], [8, '0'], [66, 1], [10, 0], [20, 0], [30, 0], [70, 64], [71, 4], [72, 4],
  [1001, 'OTHER_3D'], [1000, 'Foreign payload remains literal'],
  ...vertex(0, 0, 0), ...vertex(1, 0, 0), ...vertex(0, 1, 0), ...vertex(0, 0, 1),
  ...face(1, 3, 2), ...face(1, 2, 4), ...face(2, 3, 4), ...face(3, 1, 4),
  [0, 'SEQEND'], [8, '0'], [0, 'ENDSEC'], [0, 'EOF'],
] as Pair[]).flatMap(([code, value]) => [String(code), String(value)]).join('\r\n') + '\r\n';

describe('default-ready 3D tools keep existing import/save behavior', () => {
  it('retains foreign polyfaces without adding a new 3D DWG refusal by default', async () => {
    for (const preferences of [{}, { experimental3d: false }, { experimental3d: true, importForeign3d: false }, { experimental3d: false, importForeign3d: true }]) {
      const ed = editor(preferences);
      const state = (await ed.readDxfText(foreign, 'private-polyface.dxf'))!;
      expect(state.model3d?.solids.length ?? 0).toBe(0);
      expect(model3dDwgRefusal(state)).toBeNull();
      ed.doc.load(state);
      ed.doc.addEntities([{ id: 'new-line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 2, y: 2 }, b: { x: 3, y: 2 } }]);
      const saved = writeDxf(ed.doc.snapshot);
      const reopened = readDxf(saved, { model3d: true });
      expect(reopened.entities.some(entity => entity.type === 'line')).toBe(true);
      expect(reopened.model3d?.solids).toHaveLength(1);
      expect(meshVolume(reopened.model3d!.solids[0]!.mesh)).toBeCloseTo(1 / 6, 12);
      expect(saved).toContain('Foreign payload remains literal');
    }
  });

  it('honors explicit and migrated foreign-import opt-ins with the existing DWG guard', async () => {
    for (const preferences of [{ experimental3d: true }, { experimental3d: true, importForeign3d: true }]) {
      const state = (await editor(preferences).readDxfText(foreign, 'private-polyface.dxf'))!;
      expect(state.model3d?.solids).toHaveLength(1);
      expect(meshVolume(state.model3d!.solids[0]!.mesh)).toBeCloseTo(1 / 6, 12);
      expect(model3dDwgRefusal(state)).not.toBeNull();
    }
  });

  it('keeps own models through import, 2D editing and fresh reopen regardless of the preferences', async () => {
    const source = readFileSync('tests/fixtures/3d/cable-tray.dxf', 'utf8');
    const expected = readDxf(source, { model3d: true }).model3d;
    expect(expected!.solids.length).toBeGreaterThan(0);
    for (const preferences of [{}, { experimental3d: false }, { experimental3d: true, importForeign3d: false }]) {
      const ed = editor(preferences);
      const state = (await ed.readDxfText(source, 'private-own-model.dxf'))!;
      expectContent(state.model3d, expected);
      ed.doc.load(state);
      ed.doc.addEntities([{ id: 'added', type: 'line', layer: '0', color: 'ByLayer', a: { x: 10, y: 0 }, b: { x: 11, y: 0 } }]);
      expectContent((await ed.readDxfText(writeDxf(ed.doc.snapshot), 'private-own-model-saved.dxf'))!.model3d, expected);
    }
  });
});
