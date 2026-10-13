import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readDxf, writeDxf } from '../src/io/dxf';
import { Drawing, prepareDrawingTransition, type DrawingState } from '../src/core/document';
import { complexLinetypeProblem, MAX_LINETYPE_ELEMENTS, type Linetype } from '../src/core/linetypes';
import { shapeStylesOf, textStylesOf } from '../src/io/encoding';
import { importReportOf } from '../src/io/import-report';

const source = readFileSync(new URL('./fixtures/interchange/r2018-truecolor-linetypes.dxf', import.meta.url), 'utf8');
type Pair = readonly [number, string | number];
function native(elements: readonly Pair[], count = 1, name = 'CUSTOM', extra: readonly Pair[] = []): string {
  const pairs: Pair[] = [[0, 'SECTION'], [2, 'TABLES'], [0, 'LTYPE'], [5, 'AA'], [2, name], [70, 48], [3, 'Native complex'], [72, 65], [73, count], [40, 12], ...elements, ...extra,
    [0, 'STYLE'], [5, 'BB'], [2, 'LABEL'], [70, 0], [40, 0], [41, 1], [50, 0], [71, 0], [42, 2.5], [3, 'arial.ttf'], [4, ''],
    [0, 'STYLE'], [5, 'CC'], [2, ''], [70, 1], [40, 0], [41, 1], [50, 0], [71, 0], [42, 2.5], [3, 'ltypeshp.shx'], [4, ''],
    [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES'], [0, 'LINE'], [8, '0'], [6, name], [10, 0], [20, 0], [11, 100], [21, 0], [0, 'ENDSEC'], [0, 'EOF']];
  return pairs.map(([code, value]) => `${code}\n${value}`).join('\n');
}
const text: Pair[] = [[49, -12], [74, 3], [75, 0], [340, 'BB'], [46, 2], [50, Math.PI / 4], [44, -3], [45, 1.5], [9, ' GAS  ']];
function linetype(state: DrawingState, name = 'CUSTOM'): Linetype { return state.header!.linetypes.find((lt) => lt.name === name)!; }
function records(dxf: string, kind: string): Pair[][] {
  const lines = dxf.trimEnd().split(/\r?\n/), out: Pair[][] = [];
  let record: Pair[] | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]), value = lines[i + 1]!;
    if (code === 0) { record = value === kind ? [] : null; if (record) out.push(record); }
    else record?.push([code, value]);
  }
  return out;
}
const value = (record: readonly Pair[], code: number) => record.find(([c]) => c === code)?.[1];

describe('native complex linetype definitions and STYLE references', () => {
  it('retains gas text and anonymous shape resources through edit, undo/redo and fresh reopen', () => {
    const doc = new Drawing(readDxf(source)), before = doc.snapshot.header!.linetypes;
    expect(linetype(doc.snapshot, 'GAS_LINE').complex!.elements[1]).toMatchObject({ flags: 2, shapeNumber: 0, style: { kind: 'text', name: 'Standard', sourceHandle: '11' }, scale: 2.54, rotation: 0, offsetX: -2.54, offsetY: -1.27, text: 'GAS' });
    expect(linetype(doc.snapshot, 'FENCELINE1').complex!.elements[1]).toMatchObject({ flags: 4, shapeNumber: 133, style: { kind: 'shape', sourceId: '32' }, scale: 2.54, rotation: 0, offsetX: -2.54, offsetY: 0 });
    expect(shapeStylesOf(doc.snapshot)['32']).toEqual({ name: '', flags: 1, font: 'ltypeshp.shx', bigFont: '', height: 0, widthFactor: 1, oblique: 0, generation: 0, lastHeight: 2.5 });
    expect(Object.keys(textStylesOf(doc.snapshot))).toEqual(['Standard']);
    doc.addEntities([{ id: 'edit', type: 'line', layer: '0', color: 1, a: { x: 0, y: 0 }, b: { x: 5, y: 8 } }]);
    expect(doc.dirty).toBe(true); expect(doc.undo()).toBe(true); expect(doc.redo()).toBe(true);
    expect(doc.snapshot.header!.linetypes).toBe(before);
    const written = writeDxf(doc.snapshot), reopened = new Drawing(readDxf(written)).snapshot;
    expect(linetype(reopened, 'GAS_LINE').complex!.elements[1]).toMatchObject({ flags: 2, text: 'GAS', style: { kind: 'text', name: 'Standard' }, scale: 2.54 });
    const shapeReference = linetype(reopened, 'FENCELINE1').complex!.elements[1]!.style!;
    expect(shapeReference.kind).toBe('shape');
    if (shapeReference.kind === 'shape') expect(shapeStylesOf(reopened)[shapeReference.sourceId]).toEqual(shapeStylesOf(doc.snapshot)['32']);
    expect(reopened.entities.some((entity) => entity.id === 'edit')).toBe(false); // IDs regenerate; edited geometry remains.
    expect(reopened.entities.some((entity) => entity.type === 'line' && entity.b.x === 5 && entity.b.y === 8)).toBe(true);
    const shapes = records(written, 'STYLE').filter((record) => Number(value(record, 70)) & 1);
    expect(shapes).toHaveLength(1); expect(value(shapes[0]!, 2)).toBe('');
    expect(value(shapes[0]!, 3)).toBe('ltypeshp.shx'); expect(value(shapes[0]!, 42)).toBe('2.5');
    const pointers = records(written, 'LTYPE').flatMap((record) => record.filter(([code]) => code === 340).map(([, handle]) => handle));
    const styleHandles = records(written, 'STYLE').map((record) => value(record, 5));
    expect(pointers.every((handle) => styleHandles.includes(handle))).toBe(true);
    expect(pointers).toContain('11'); expect(pointers).toContain('32');
    expect(new Set(styleHandles).size).toBe(styleHandles.length);
  });
  it('retains trailing/leading literal text, native radians, and absolute/unknown rotation flags', () => {
    for (const flags of [2, 3, 10]) {
      const input = readDxf(native(text.map((pair) => pair[0] === 74 ? [74, flags] : pair)));
      expect(linetype(input).complex!.elements[0]!.text).toBe(' GAS  ');
      const reopened = readDxf(writeDxf(input)), complex = linetype(reopened).complex!;
      expect(complex.elements[0]).toMatchObject({ flags, text: ' GAS  ', shapeNumber: 0, style: { kind: 'text', name: 'LABEL' }, scale: 2, offsetX: -3, offsetY: 1.5 });
      expect(complex.elements[0]!.rotation).toBeCloseTo(Math.PI / 4, 10);
      expect(complex).toMatchObject({ flags: 48, alignment: 65, totalPatternLength: 12 });
      expect(importReportOf(input)?.items.some((item) => item.type === 'LTYPE' && item.action === 'kept')).toBe(true);
    }
  });
  it('retains Unicode embedded text using DXF escapes without changing header group9 semantics', () => {
    const input = readDxf(native(text.map((pair) => pair[0] === 9 ? [9, ' Señal  '] : pair)));
    const written = writeDxf(input);
    expect(written).toContain('Se\\U+00F1al  ');
    expect(linetype(readDxf(written)).complex!.elements[0]!.text).toBe(' Señal  ');
  });
  it('preserves complex data even when a standard linetype has an identical simple pattern', () => {
    const input = readDxf(native([[49, 0.5], ...text.slice(1), [49, -0.25], [74, 0]], 2, 'DASHED'));
    expect(linetype(input, 'DASHED').complex!.elements[0]!.text).toBe(' GAS  ');
    expect(linetype(readDxf(writeDxf(input)), 'DASHED').complex!.elements[0]!.text).toBe(' GAS  ');
  });
  it('keeps ordinary dash definitions on the unchanged simple API', () => {
    const input = readDxf(native([[49, 12], [74, 0]], 1));
    expect(linetype(input)).toEqual({ name: 'CUSTOM', description: 'Native complex', pattern: [12] });
    expect(linetype(readDxf(writeDxf(input))).complex).toBeUndefined();
  });
  it('retains unused shape resources after a linetype-only purge and shares one identity across references', () => {
    const shape: Pair[] = [[49, -6], [74, 5], [75, 133], [340, 'CC'], [50, Math.PI / 6]];
    const input = readDxf(native([...shape, ...shape], 2));
    expect(linetype(input).complex!.elements.map((element) => element.style)).toEqual([{ kind: 'shape', sourceId: 'CC' }, { kind: 'shape', sourceId: 'CC' }]);
    const written = writeDxf(prepareDrawingTransition(input, { ...input, entities: [], header: { ...input.header!, linetypes: [] } }));
    expect(records(written, 'STYLE').filter((record) => Number(value(record, 70)) & 1)).toHaveLength(1);
    expect(Object.values(shapeStylesOf(readDxf(written)))[0]!.font).toBe('ltypeshp.shx');
  });
});

describe('explicit complex linetype safety and unsupported-data reporting', () => {
  it.each(['ByLayer', 'ByBlock', 'Continuous'])('retains and refuses complex data on reserved %s instead of dropping it or duplicating records', (name) => {
    const input = readDxf(native(text, 1, name));
    expect(linetype(input, name).complex).toBeDefined();
    expect(() => writeDxf(input)).toThrow('reserved linetype');
  });
  it('recognizes raw descriptor fields on74=0 and unresolved references; saving cannot drop them', () => {
    const input = readDxf(native([[49, -12], [74, 0], [340, 'DEAD'], [46, 2], [9, 'KEEP']]));
    expect(linetype(input).complex!.elements[0]).toMatchObject({ flags: 0, style: { kind: 'unresolved', sourceHandle: 'DEAD' }, text: 'KEEP', scale: 2 });
    expect(() => writeDxf(input)).toThrow('unresolved');
    const missing = readDxf(native(text.filter(([code]) => code !== 340)));
    expect(() => writeDxf(missing)).toThrow('STYLE reference is missing');
  });
  it('refuses missing live text/shape resources rather than synthesizing different default fonts', () => {
    const input = readDxf(native(text));
    expect(() => writeDxf({ ...input, meta: {} })).toThrow('text STYLE');
    const shape = readDxf(native([[49, 12], [74, 4], [75, 133], [340, 'CC']]));
    expect(() => writeDxf({ ...shape, meta: { textStyles: textStylesOf(shape) } })).toThrow('STYLE resource is missing');
  });
  it.each([
    { elements: [...text, [74, 2] as Pair], count: 1 },
    { elements: [[74, 2] as Pair, ...text], count: 1 },
    { elements: text, count: 2 },
    { elements: Array.from({ length: MAX_LINETYPE_ELEMENTS + 1 }, () => [49, 1] as Pair).concat([[74, 2], [9, 'too many']]), count: MAX_LINETYPE_ELEMENTS + 1 },
  ])('rejects ambiguous descriptor ordering/counts before allocating or silently dropping fields: %j', ({ elements, count }) => {
    expect(() => readDxf(native(elements, count))).toThrow(/Invalid complex linetype/);
  });
  it('rejects malformed authored transforms, sparse elements and invalid shape resources before Writer formatting', () => {
    const input = readDxf(native(text)), lt = linetype(input);
    const bad = { ...lt, complex: { ...lt.complex!, elements: [{ ...lt.complex!.elements[0]!, rotation: Infinity }] } };
    expect(complexLinetypeProblem(bad)).toMatch(/transform/);
    expect(() => writeDxf({ ...input, header: { ...input.header!, linetypes: [bad] } })).toThrow(/transform/);
    const sparse = { ...lt, complex: { ...lt.complex!, elements: Array(1) } };
    expect(() => writeDxf({ ...input, header: { ...input.header!, linetypes: [sparse] } })).toThrow(/element/);
    expect(() => writeDxf({ ...input, meta: { ...input.meta, shapeStyles: { CC: { ...shapeStylesOf(input)['CC'], lastHeight: NaN } } } })).toThrow('shape STYLE');
  });
  it('retains opaque extension metadata alongside the modeled descriptors', () => {
    const input = readDxf(native(text, 1, 'CUSTOM', [[1001, 'UNKNOWN_APP'], [1000, 'UNMODELED']]));
    expect(linetype(input).complex!.elements[0]!.text).toBe(' GAS  ');
    const reopened = readDxf(writeDxf(input));
    expect(linetype(reopened).complex!.elements[0]!.text).toBe(' GAS  ');
    const retained = reopened.cadGraph!.nodes.find(node => node.type === 'LTYPE' && node.anchor?.kind === 'table' && node.anchor.name === 'CUSTOM')!;
    expect(retained.groups).toContainEqual([1001, 'UNKNOWN_APP']);
    expect(retained.groups).toContainEqual([1000, 'UNMODELED']);
    expect(importReportOf(reopened)?.items.some((item) => item.type === 'LTYPE' && item.action === 'dropped')).toBe(false);
  });
});
