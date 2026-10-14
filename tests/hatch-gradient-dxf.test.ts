import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Drawing } from '../src/core/document';
import type { HatchEntity, HatchGradient } from '../src/core/entities';
import { translateEntity } from '../src/core/entities';
import { defaultLayout } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { importReportOf } from '../src/io/import-report';

type Pair = readonly [number, string | number];
const names = ['LINEAR', 'CYLINDER', 'INVCYLINDER', 'SPHERICAL', 'INVSPHERICAL', 'HEMISPHERICAL', 'INVHEMISPHERICAL', 'CURVED', 'INVCURVED'];
const nativeGradient: Pair[] = [[450, 1], [451, 0], [460, Math.PI / 3], [461, 0.35], [452, 1], [462, 0.65], [453, 2], [463, 0], [63, 1], [421, 0xd83020], [463, 1], [63, 4], [421, 0x30c0d0], [470, 'LINEAR']];
// Independently authored native fields, rather than creating input through the writer being tested.
function nativeDxf(gradient: readonly Pair[] = nativeGradient, pattern = false): string {
  const fields: Pair[] = [[0, 'SECTION'], [2, 'HEADER'], [9, '$ACADVER'], [1, 'AC1018'], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'],
    [0, 'HATCH'], [5, 'A1'], [8, 'GRADIENT'], [100, 'AcDbEntity'], [100, 'AcDbHatch'], [10, 0], [20, 0], [30, 0], [210, 0], [220, 0], [230, 1],
    [2, pattern ? 'ANSI31' : 'SOLID'], [70, pattern ? 0 : 1], [71, 0], [91, 2],
    [92, 3], [72, 0], [73, 1], [93, 4], [10, 0], [20, 0], [10, 12], [20, 0], [10, 12], [20, 8], [10, 0], [20, 8], [97, 0],
    [92, 2], [72, 0], [73, 1], [93, 4], [10, 4], [20, 2], [10, 8], [20, 2], [10, 8], [20, 6], [10, 4], [20, 6], [97, 0], [75, 0], [76, 1],
    ...(pattern ? [[52, 30], [41, 2], [77, 0], [78, 0]] as Pair[] : []), [98, 0], ...gradient, [0, 'ENDSEC'], [0, 'EOF']];
  return fields.flat().join('\n');
}
const hatchFrom = (text: string): HatchEntity => readDxf(text).entities[0] as HatchEntity;
const replace = (code: number, value: string | number, pairs: readonly Pair[] = nativeGradient): Pair[] => pairs.map((pair) => pair[0] === code ? [code, value] : pair);
function gradientOf(name = 'LINEAR'): HatchGradient {
  return { name, angle: Math.PI / 3, shift: 0.35, singleColor: true, tint: 0.65, colors: [{ position: 0, color: 1, trueColor: 0xd83020 }, { position: 1, color: 4, trueColor: 0x30c0d0 }] };
}
function closeGradient(actual: HatchGradient | undefined, expected: HatchGradient): void {
  expect(actual).toMatchObject({ ...expected, angle: expect.any(Number), shift: expect.any(Number), tint: expect.any(Number) });
  expect(actual!.angle).toBeCloseTo(expected.angle, 9);
  expect(actual!.shift).toBeCloseTo(expected.shift, 9);
  expect(actual!.tint).toBeCloseTo(expected.tint, 9);
}

describe('native DXF gradient HATCH', () => {
  it('reopens all eighteen native AutoCAD-normalized types and retains their metadata after edit/save', () => {
    const state = readDxf(readFileSync(join(__dirname, 'fixtures/interchange/r2018-gradient-hatches.dxf'), 'utf8'));
    const gradients = state.entities.filter((entity): entity is HatchEntity => entity.type === 'hatch' && !!entity.gradient);
    expect(gradients).toHaveLength(18);
    for (const name of names) {
      const pair = gradients.filter((hatch) => hatch.gradient!.name === name);
      expect(pair.map((hatch) => hatch.gradient!.shift).sort()).toEqual([0, 1]);
      for (const hatch of pair) expect(hatch.gradient).toMatchObject({ angle: 0, singleColor: false, tint: 0, colors: [{ position: 0, color: 0 }, { position: 1, color: 7, trueColor: 0xffffff }] });
    }
    const modified = state.entities.map((entity) => translateEntity(entity, { x: 5, y: 7 }));
    const saved = writeDxf({ ...state, entities: modified });
    const reopened = readDxf(saved).entities.filter((entity): entity is HatchEntity => entity.type === 'hatch' && !!entity.gradient);
    expect(reopened.map((hatch) => hatch.gradient)).toEqual(gradients.map((hatch) => hatch.gradient));
    expect(reopened[0]!.loops[0]!.points[0]).toEqual({ x: 5, y: 7 });
  });

  it.each(names)('retains native %s parameters and both independent ACI/RGB colors', (name) => {
    const hatch = hatchFrom(nativeDxf(replace(470, name)));
    closeGradient(hatch.gradient, gradientOf(name));
    expect(hatch.angle).toBe(0); // 460 is already radians, not the pattern's degree-valued 52.
    expect(hatch.loops).toHaveLength(2);
    const reopened = hatchFrom(writeDxf({ ...new Drawing().snapshot, entities: [hatch] }));
    closeGradient(reopened.gradient, gradientOf(name));
    expect(reopened.loops).toEqual(hatch.loops);
  });

  it('retains disabled metadata and reports a patterned combination that native DXF cannot preserve', () => {
    const disabled = nativeGradient.filter(([code]) => ![463, 63, 421].includes(code));
    const hatch = hatchFrom(nativeDxf(replace(453, 0, replace(450, 0, disabled)), true));
    expect(hatch).toMatchObject({ solid: false, pattern: 'ANSI31', gradient: { kind: 0, colorCount: 0, colors: [] } });
    expect(hatch.angle).toBeCloseTo(Math.PI / 6);
    expect(() => writeDxf({ ...new Drawing().snapshot, entities: [hatch] })).toThrow(/patterned hatch.*gradient settings.*native DXF/);
    expect(importReportOf(readDxf(nativeDxf(replace(453, 0, replace(450, 0, disabled)), true)))?.items).toContainEqual(expect.objectContaining({ action: 'kept', reason: expect.stringMatching(/data and pattern are retained; native export is unavailable/) }));
  });

  it.each([1, 0])('retains custom pattern families alongside gradient kind %s and refuses destructive native export', (kind) => {
    const input = nativeDxf(replace(450, kind), true).replace('78\n0\n', '78\n1\n53\n30\n43\n2\n44\n3\n45\n-1\n46\n4\n79\n3\n49\n5\n49\n-2\n49\n0\n');
    const h = hatchFrom(input);
    expect(h.patternLines).toHaveLength(1);
    expect(h.patternLines![0]).toMatchObject({ base: { x: 2, y: 3 }, offset: { x: -1, y: 4 }, dashes: [5, -2, 0] });
    const doc = new Drawing(readDxf(input));
    doc.replaceEntities([translateEntity(doc.entities[0]!, { x: 3, y: 4 })]);
    expect(doc.undo()).toBe(true); expect(doc.redo()).toBe(true);
    const before = doc.snapshot, history = doc.history();
    expect(() => writeDxf(doc.snapshot)).toThrow(/patterned hatch.*gradient settings.*native DXF/);
    expect(doc.snapshot).toBe(before); expect(doc.history()).toEqual(history);
    expect((doc.entities[0] as HatchEntity).patternLines![0]).toMatchObject({ base: { x: 5, y: 7 }, offset: { x: -1, y: 4 }, dashes: [5, -2, 0] });
    expect((doc.entities[0] as HatchEntity).gradient).toEqual(h.gradient);
  });

  it('retains unknown names, future flags and finite bounded color arrays with an explicit fallback report', () => {
    const tail: Pair[] = [[450, 2], [451, 9], [460, 0.5], [461, 0.25], [452, 3], [462, 0.5], [453, 3], [463, 0], [63, 0], [463, 0.4], [421, 0xabcdef], [463, 1], [63, 256], [470, 'FUTURE_GRADIENT']];
    const state = readDxf(nativeDxf(tail));
    const hatch = state.entities[0] as HatchEntity;
    expect(hatch.gradient).toMatchObject({ name: 'FUTURE_GRADIENT', kind: 2, reserved: 9, colorMode: 3, colorCount: 3, colors: [{ position: 0, color: 0 }, { position: 0.4, trueColor: 0xabcdef }, { position: 1, color: 256 }] });
    expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'HATCH', action: 'kept', reason: expect.stringMatching(/gradient.*retained.*fallback/) }));
    const again = hatchFrom(writeDxf(state));
    expect(again.gradient).toEqual(hatch.gradient);
  });

  it('reports shifted LINEAR as a display fallback while keeping its complete native definition', () => {
    const state = readDxf(nativeDxf());
    expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ action: 'kept', reason: expect.stringMatching(/fallback.*shifted gradient rendering is unsupported/) }));
    closeGradient(hatchFrom(writeDxf(state)).gradient, gradientOf());
    const unshifted = readDxf(nativeDxf(replace(461, 0)));
    expect(importReportOf(unshifted)?.items.some((item) => /gradient/.test(item.reason))).not.toBe(true);
  });

  it('uses AC1018 for gradients in model space, block definitions and paper layouts, including inert metadata', () => {
    const hatch = hatchFrom(nativeDxf());
    const empty = new Drawing().snapshot;
    const states = [
      { ...empty, entities: [hatch] },
      { ...empty, blocks: { G: { name: 'G', basePoint: { x: 0, y: 0 }, entities: [hatch], attributes: [] } } },
      { ...empty, layouts: [{ ...defaultLayout('Gradient sheet'), entities: [hatch], viewports: [] }] },
      { ...empty, entities: [{ ...hatch, gradient: { ...hatch.gradient!, kind: 0, colors: [], colorCount: 0 } }] },
    ];
    for (const state of states) expect(writeDxf(state)).toContain('AC1018');
    expect(writeDxf({ ...empty, entities: [{ ...hatch, gradient: undefined }] })).toContain('AC1015');
  });

  it('imports, edits, undoes/redoes, saves and reopens gradient metadata in every drawing space', () => {
    const native = hatchFrom(nativeDxf());
    const empty = new Drawing().snapshot;
    const drawing = new Drawing(readDxf(writeDxf({ ...empty, entities: [{ ...native, id: 'model' }],
      blocks: { G: { name: 'G', basePoint: { x: 0, y: 0 }, entities: [{ ...native, id: 'block' }], attributes: [] } },
      layouts: [{ ...defaultLayout('Gradient sheet'), entities: [{ ...native, id: 'paper' }], viewports: [] }],
    })));
    const before = drawing.snapshot;
    drawing.transactDrawing((state) => ({ ...state, entities: state.entities.map((entity) => translateEntity(entity, { x: 3, y: 2 })),
      blocks: { ...state.blocks, G: { ...state.blocks.G!, entities: state.blocks.G!.entities.map((entity) => translateEntity(entity, { x: 3, y: 2 })) } },
      layouts: state.layouts!.map((layout) => ({ ...layout, entities: layout.entities.map((entity) => translateEntity(entity, { x: 3, y: 2 })) })),
    }));
    expect(drawing.dirty).toBe(true);
    expect((drawing.snapshot.entities[0] as HatchEntity).loops[0]!.points[0]).toEqual({ x: 3, y: 2 });
    drawing.undo();
    expect(drawing.snapshot.entities).toEqual(before.entities);
    drawing.redo();
    const reopened = readDxf(writeDxf(drawing.snapshot));
    const retained = [reopened.entities[0], reopened.blocks.G!.entities[0], reopened.layouts!.find((layout) => layout.name === 'Gradient sheet')!.entities[0]] as HatchEntity[];
    for (const hatch of retained) {
      closeGradient(hatch.gradient, native.gradient!);
      expect(hatch.loops[0]!.points[0]).toEqual({ x: 3, y: 2 });
    }
  });

  it('does not emit gradient groups or change ordinary solid/pattern behavior when no metadata exists', () => {
    for (const pattern of [false, true]) {
      const hatch = hatchFrom(nativeDxf([], pattern));
      expect(hatch.gradient).toBeUndefined();
      const saved = writeDxf({ ...new Drawing().snapshot, entities: [hatch] });
      expect(saved).not.toMatch(/\r\n(?:450|451|452|453|460|461|462|463|470)\r\n/);
      const reopened = hatchFrom(saved);
      expect(reopened).toMatchObject({ pattern: hatch.pattern, solid: hatch.solid });
      expect(reopened.angle).toBeCloseTo(hatch.angle, 9);
      expect(reopened.scale).toBeCloseTo(hatch.scale, 8);
    }
  });

  it('rejects malformed, out-of-range and oversized fields with source-context import reports', () => {
    const badTails = [
      ...[450, 451, 452, 453, 460, 461, 462, 470].map((missing) => nativeGradient.filter(([code]) => code !== missing)),
      ...[460, 461, 462, 463].flatMap((code) => ['NaN', 'Infinity', '1junk', '1e309'].map((value) => replace(code, value))),
      ...[[-1, 461], [1.1, 461], [-1, 462], [1.1, 462], [-1, 463], [1.1, 463], [-1, 453], [17, 453], [1, 453], [2.5, 453], [-1, 63], [257, 63], [-1, 421], [0x1000000, 421], [0x80000000, 450]].map(([value, code]) => replace(code!, value!)),
      [...nativeGradient, [450, 1]] as Pair[],
      nativeGradient.filter(([code]) => ![63, 421].includes(code)),
      replace(470, ''), replace(470, 'X'.repeat(257)),
      [...nativeGradient.filter(([code]) => ![463, 63, 421].includes(code)), ...Array.from({ length: 17 }, (_, i): Pair[] => [[463, i / 16], [421, 0xabcdef]]).flat()] as Pair[],
    ];
    for (const tail of badTails) {
      const state = readDxf(nativeDxf(tail));
      expect(state.entities, JSON.stringify(tail)).toEqual([]);
      expect(importReportOf(state)?.items).toContainEqual(expect.objectContaining({ type: 'HATCH', action: 'dropped', handle: 'A1', layer: 'GRADIENT', where: 'model space', reason: expect.stringMatching(/invalid.*(?:gradient|numeric)/) }));
    }
  });

  it('refuses invalid gradient saves before numeric formatting can silently replace fields', () => {
    const hatch = hatchFrom(nativeDxf());
    const invalid: HatchGradient[] = [
      { ...gradientOf(), angle: NaN }, { ...gradientOf(), shift: 2 }, { ...gradientOf(), tint: -1 },
      { ...gradientOf(), colors: [{ position: 0, trueColor: 0x1000000 }] },
      { ...gradientOf(), colorCount: 1 }, { ...gradientOf(), name: 'LINEAR\nINJECT' },
    ];
    for (const gradient of invalid) expect(() => writeDxf({ ...new Drawing().snapshot, entities: [{ ...hatch, gradient }] })).toThrow(/Cannot preserve hatch gradient/);
  });

  it('refuses permanently flattened affine frames while preserving gradients in native block definitions', () => {
    const hatch = hatchFrom(nativeDxf());
    const empty = new Drawing().snapshot;
    const flattened: HatchEntity = { ...hatch, gradientFrame: { origin: { x: 0, y: 0 }, x: { x: 24, y: 0 }, y: { x: 0, y: 8 } } };
    expect(() => writeDxf({ ...empty, entities: [flattened] })).toThrow(/Cannot preserve a transformed hatch gradient frame/);
    const saved = writeDxf({ ...empty,
      blocks: { G: { name: 'G', basePoint: { x: 0, y: 0 }, entities: [hatch], attributes: [] } },
      entities: [{ id: 'insert', type: 'insert', layer: '0', color: 'ByLayer', block: 'G', position: { x: 2, y: 3 }, scale: 2, scaleY: 3, rotation: 0.25, attributes: {} }],
    });
    const reopened = readDxf(saved);
    closeGradient((reopened.blocks.G!.entities[0] as HatchEntity).gradient, hatch.gradient!);
    expect(reopened.entities[0]).toMatchObject({ type: 'insert', scale: 2, scaleY: 3 });
  });
});
