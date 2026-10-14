import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { dimensionGeometry, dimensionMeasurement, dimensionTextPoint, STANDARD_DIMSTYLE, type DimensionEntity } from '../src/core/dimension';
import { dimensionParts, entityBounds, explodeInsert, gripPoints, moveGrip, mirrorEntityAcross, rotateEntity, scaleEntityBy, type BlockLookup, type InsertEntity, type LineEntity, type TextEntity } from '../src/core/entities';
import type { TextGeometryContext } from '../src/core/text-metrics';
import { defaultLayout } from '../src/core/layouts';
import { dwgCompatibilityProblem } from '../src/app/dwg-compatibility';
import { readDxf, writeDxf } from '../src/io/dxf';

const fixture = readFileSync(join(__dirname, 'fixtures/interchange/r2018-ordinate-dimensions.dxf'), 'utf8');
const style = { ...STANDARD_DIMSTYLE, textHeight: 2.5, arrowSize: 2.5, extOffset: 0.625, textGap: 0.625, decimals: 2 };
const ordinate = (extra: Partial<DimensionEntity> = {}): DimensionEntity => ({ type: 'dimension', id: 'ordinate', layer: '0', color: 'ByLayer', kind: 'ordinate', ordinateAxis: 'x', ordinateRotation: 0,
  p1: { x: 0, y: 0 }, p2: { x: 25, y: 35 }, linePoint: { x: 25, y: 70 }, rotation: 0, style, ...extra });
const imported = () => readDxf(fixture).entities.filter((e): e is DimensionEntity => e.type === 'dimension');
const xy = (point: { x: number; y: number }) => [point.x, point.y];
const nearPoint = (actual: { x: number; y: number }, expected: readonly number[]) => { expect(actual.x).toBeCloseTo(expected[0]!, 8); expect(actual.y).toBeCloseTo(expected[1]!, 8); };
const inkMeasure = (text: string, height: number) => ({ '25.00': 9.166666666666666, '30.00': 8.75, '65.00': 9.166666666666666, '105.00': 10.416666666666666 }[text] ?? 10) * height / 2.5;
const lines = (d: DimensionEntity) => dimensionGeometry(d, inkMeasure).filter((e): e is LineEntity => e.type === 'line');

describe('native XY ordinate definitions', () => {
  it('imports all 20 independently authored native ordinate records with their datum/text angles', () => {
    const dimensions = imported(); expect(dimensions).toHaveLength(20);
    expect(dimensions.every((d) => d.kind === 'ordinate')).toBe(true);
    expect(dimensions[0]!.ordinateAxis).toBe('x'); expect(dimensions[5]!.ordinateAxis).toBe('y');
    expect(dimensions[0]!.textRotation).toBeCloseTo(Math.PI / 9, 12);
    expect(dimensions[18]!.ordinateRotation).toBeCloseTo(5 * Math.PI / 6, 12);
    expect(dimensions[19]!.ordinateAxis).toBe('y');
    nearPoint(dimensions[16]!.textPosition!, [200, 5]); expect(dimensions[16]!.text).toBe('OFFSET <>');
    [25, 20.47880110722485, 25, 65, 105, 70, 30, 30, 145, 185, 225, 265, 25, 65, 105, 145, 185, 225, 25, 35].forEach((value, i) => expect(dimensionMeasurement(dimensions[i]!)).toBeCloseTo(value, 8));
  });
  it.each(['x', 'y'] as const)('measures the absolute %s coordinate relative to a shifted datum', (ordinateAxis) => {
    expect(dimensionMeasurement(ordinate({ ordinateAxis, p1: { x: 100, y: 70 }, p2: { x: 80, y: 35 } }))).toBe(ordinateAxis === 'x' ? 20 : 35);
  });
  it('keeps an explicitly horizontal text angle distinct from the natural X-ordinate vertical baseline', () => {
    const source = ordinate({ textRotation: 0 }), doc = new Drawing({ entities: [source] }), encoded = writeDxf(doc.snapshot);
    expect(encoded).toMatch(/53\r?\n360\r?\n/); const back = readDxf(encoded).entities[0] as DimensionEntity;
    expect(back.textRotation).toBe(0); expect(dimensionGeometry(back, inkMeasure).find((part): part is TextEntity => part.type === 'text')!.rotation).toBe(0);
  });
  it('roundtrips canonical native flags, all definition points, exact text overrides and datum frames through edit/undo/redo', () => {
    const doc = new Drawing(readDxf(fixture)), original = doc.entities[0] as DimensionEntity;
    const edit = { ...original, p2: { ...original.p2, x: 28 }, text: 'X=<>', textPosition: { x: 50, y: 60 } };
    doc.replaceEntities([edit]); expect(doc.dirty).toBe(true); doc.undo(); expect(doc.entity(original.id)).toEqual(original); doc.redo(); expect(doc.entity(original.id)).toEqual(edit);
    const encoded = writeDxf(doc.snapshot); expect(encoded.match(/AcDbOrdinateDimension/g)).toHaveLength(20);
    const back = readDxf(encoded).entities.filter((e): e is DimensionEntity => e.type === 'dimension'); expect(back).toHaveLength(20);
    back.forEach((d, i) => { const expected = doc.entities[i] as DimensionEntity; expect(d.kind).toBe('ordinate'); expect(d.ordinateAxis).toBe(expected.ordinateAxis); expect(d.ordinateRotation).toBeCloseTo(expected.ordinateRotation ?? 0, 8);
      nearPoint(d.p1, xy(expected.p1)); nearPoint(d.p2, xy(expected.p2)); nearPoint(d.linePoint, xy(expected.linePoint)); expect(d.text).toBe(expected.text); expect(d.styleOverrides).toEqual(expected.styleOverrides); });
    nearPoint(back[0]!.textPosition!, [50, 60]); expect(back[0]!.textRotation).toBeCloseTo(original.textRotation!, 8);
  });
});

describe('native ordinate component geometry', () => {
  it('draws a leader offset by DIMEXO with no arrows and an ink-width based default text midpoint', () => {
    const d = ordinate(), parts = dimensionGeometry(d, inkMeasure); expect(lines(d)).toHaveLength(1);
    nearPoint(lines(d)[0]!.a, [25, 35.625]); nearPoint(lines(d)[0]!.b, [25, 70]); nearPoint(dimensionTextPoint(d, inkMeasure), [25, 75.20833333333333]);
    expect(parts.every((p) => p.type === 'line' || p.type === 'text')).toBe(true);
  });
  it.each([
    ['long', { x: 30, y: 55 }, { x: 45, y: 100 }, [[30, 55.625, 30, 90], [30, 90, 45, 95], [45, 95, 45, 100]]],
    ['short', { x: 30, y: 100 }, { x: 45, y: 105 }, [[30, 100.625, 30, 105], [30, 105, 45, 100], [45, 100, 45, 105]]],
    ['zero along', { x: 30, y: 125 }, { x: 45, y: 125 }, [[30, 124.375, 30, 120], [30, 120, 45, 130], [45, 130, 45, 125]]],
  ] as const)('matches the independently native %s dogleg geometry', (_label, p2, linePoint, expected) => {
    const parts = lines(ordinate({ p2, linePoint })); expect(parts).toHaveLength(expected.length); parts.forEach((p, i) => { nearPoint(p.a, expected[i]!.slice(0, 2)); nearPoint(p.b, expected[i]!.slice(2, 4)); });
  });
  it('uses DIMASZ rather than text height for both dogleg bends and DIMCLRE for line appearance', () => {
    const d = ordinate({ p2: { x: 50, y: 140 }, linePoint: { x: 70, y: 185 }, style: { ...style, arrowSize: 1, textHeight: 5, extLineColor: 3, dimLineColor: 1 } });
    const p = lines(d); nearPoint(p[0]!.b, [50, 181]); nearPoint(p[1]!.b, [70, 183]); expect(p.every((e) => e.color === 3)).toBe(true);
  });
  it('retains native suppression/horizontal settings while ordinate geometry ignores them', () => {
    const d = ordinate(); expect(dimensionGeometry(ordinate({ style: { ...style, suppressExt1: true, suppressDimLine1: true, textAlign: 'horizontal' } }), inkMeasure)).toEqual(dimensionGeometry(d, inkMeasure));
  });
  it.each([[20, 1.99533332339238], [45, 2.65165042944958], [90, 5.20833333333333]] as const)('places centered %s-degree text using the native padded-box ray intersection', (angle, shift) => {
    const d = ordinate({ p2: { x: 25, y: 0 }, linePoint: { x: 25, y: 35 }, textRotation: angle * Math.PI / 180 });
    nearPoint(dimensionTextPoint(d, inkMeasure), [25, 35 + shift]);
    const text = dimensionGeometry(d, inkMeasure).find((p): p is TextEntity => p.type === 'text')!; expect(text.rotation).toBeCloseTo(d.textRotation!, 12);
  });
  it.each(['above', 'outside', 'below'] as const)('matches native %s text offset and the extended leader under the label', (textVertical) => {
    const d = ordinate({ style: { ...style, textVertical } }); nearPoint(dimensionTextPoint(d, inkMeasure), [textVertical === 'below' ? 26.875 : 23.125, 75.20833333333333]); nearPoint(lines(d)[0]!.b, [25, 70 + 235 / 24]);
    const manual = ordinate({ textRotation: Math.PI / 9, style: { ...style, textVertical } }); nearPoint(dimensionTextPoint(manual, inkMeasure), [25, 70 + 1.99533332339238]); nearPoint(lines(manual)[0]!.b, [25, 70]);
  });
});

describe('ordinate transforms, bounds and compatibility refusals', () => {
  it('keeps direct datum/text frames fixed under ROTATE/MIRROR while the coordinate measurement changes', () => {
    const d = imported()[18]!, rotated = rotateEntity(d, { x: 0, y: 0 }, Math.PI / 6) as DimensionEntity, mirrored = mirrorEntityAcross(d, { x: 0, y: 0 }, { x: 0, y: 1 }) as DimensionEntity;
    expect(rotated.ordinateRotation).toBe(d.ordinateRotation); expect(mirrored.ordinateRotation).toBe(d.ordinateRotation);
    expect(dimensionMeasurement(rotated)).toBeCloseTo(Math.abs(25 * Math.cos(Math.PI / 6) - 35 * Math.sin(Math.PI / 6)), 8);
    const manual = imported()[0]!; expect((rotateEntity(manual, { x: 0, y: 0 }, Math.PI / 6) as DimensionEntity).textRotation).toBe(manual.textRotation);
    expect((mirrorEntityAcross(manual, { x: 0, y: 0 }, { x: 0, y: 1 }) as DimensionEntity).textRotation).toBe(manual.textRotation);
    const scaled = scaleEntityBy(manual, { x: 0, y: 0 }, -2) as DimensionEntity; expect(scaled.style).toBe(manual.style); expect(scaled.styleOverrides).toBe(manual.styleOverrides); expect(dimensionMeasurement(scaled)).toBeCloseTo(50, 8);
  });
  it('composes a uniform INSERT datum and preserves the native local coordinate after explosion', () => {
    const local = ordinate({ p2: { x: 10, y: 20 }, linePoint: { x: 10, y: 50 } }), doc = new Drawing({ blocks: { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [local], attributes: [] } } });
    const insert: InsertEntity = { id: 'insert', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 230, y: -50 }, rotation: Math.PI / 6, scale: 1, attributes: {} };
    const exploded = explodeInsert(insert, doc.lookupBlock); expect(exploded).toHaveLength(1); const result = exploded[0] as DimensionEntity;
    expect(result.kind).toBe('ordinate'); expect(result.ordinateRotation).toBeCloseTo(Math.PI / 6, 12); expect(dimensionMeasurement(result)).toBeCloseTo(10, 8);
    nearPoint(result.p2, [228.6602540378444, -27.67949192431123]);
    const nested = new Drawing({ blocks: { ...doc.blocks, OUTER: { name: 'OUTER', basePoint: { x: 0, y: 0 }, entities: [insert], attributes: [] } } });
    const outer = { ...insert, block: 'OUTER', position: { x: 0, y: 0 }, rotation: Math.PI / 6, scale: 2 };
    const nestedResult = explodeInsert(outer, nested.lookupBlock); expect(nestedResult.some((part) => part.type === 'dimension')).toBe(false);
    const nestedText = nestedResult.find((part): part is TextEntity => part.type === 'text')!; expect(nestedText.text).toBe('10.00'); expect(nestedText.height).toBe(5); expect(nestedText.rotation).toBeCloseTo(5 * Math.PI / 6, 12);
  });
  it.each([0, 1])('preserves the native standalone SCALE style sizes with DIMSCALE=%s', (scale) => {
    const source = ordinate({ p2: { x: 10, y: 20 }, linePoint: { x: 10, y: 50 }, style: { ...style, scale }, styleOverrides: { DIMSCALE: scale } });
    const scaled = scaleEntityBy(source, { x: 0, y: 0 }, 2) as DimensionEntity;
    expect(scaled.style).toBe(source.style); expect(scaled.styleOverrides).toBe(source.styleOverrides); expect(dimensionMeasurement(scaled)).toBe(20);
    const parts = dimensionGeometry(scaled, () => 8.75); nearPoint((parts[0] as LineEntity).a, [20, 40.625]);
    const text = parts.find((part): part is TextEntity => part.type === 'text')!; expect(text.height).toBe(2.5); expect(text.text).toBe('20.00');
    const back = readDxf(writeDxf(new Drawing({ entities: [scaled] }).snapshot)).entities[0] as DimensionEntity; expect(back.style.scale).toBe(scale); expect(back.styleOverrides?.DIMSCALE).toBe(scale);
  });
  it.each([0, 1])('preserves the local label and physically scaled appearance for a uniform INSERT with DIMSCALE=%s', (scale) => {
    const local = ordinate({ p2: { x: 10, y: 20 }, linePoint: { x: 10, y: 50 }, style: { ...style, scale }, styleOverrides: { DIMSCALE: scale } });
    const doc = new Drawing({ blocks: { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [local], attributes: [] } } });
    const insert: InsertEntity = { id: 'uniform', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 0, y: 0 }, rotation: 0, scale: 2, attributes: {} };
    const parts = explodeInsert(insert, doc.lookupBlock); expect(parts.some((part) => part.type === 'dimension')).toBe(false);
    const text = parts.find((part): part is TextEntity => part.type === 'text')!; expect(text.text).toBe('10.00'); expect(text.height).toBe(5);
    nearPoint((parts[0] as LineEntity).a, [20, 41.25]); nearPoint((parts[0] as LineEntity).b, [20, 100]);
    doc.addEntities([insert]); const saved = readDxf(writeDxf(doc.snapshot)); expect((saved.blocks.B!.entities[0] as DimensionEntity).kind).toBe('ordinate'); expect(saved.entities[0]!.type).toBe('insert');
  });
  it.each(['scaled', 'nonuniform', 'nested'] as const)('rebuilds context-dependent %s primitives when font metrics change', (mode) => {
    const local = ordinate({ text: 'A' });
    const insert: InsertEntity = { id: 'cached', type: 'insert', layer: '0', color: 'ByLayer', block: mode === 'nested' ? 'OUTER' : 'B', position: { x: 0, y: 0 }, rotation: 0, scale: 2, ...(mode === 'scaled' ? {} : { scaleY: 3 }), attributes: {} };
    const child = { ...insert, id: 'child', block: 'B', scale: 1, scaleY: 1, rotation: Math.PI / 6 };
    const doc = new Drawing({ entities: [insert], blocks: { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [local], attributes: [] }, ...(mode === 'nested' ? { OUTER: { name: 'OUTER', basePoint: { x: 0, y: 0 }, entities: [child], attributes: [] } } : {}) } });
    const context = (width: number): TextGeometryContext => ({ cacheKey: {}, resolve: () => ({ kind: 'canvas', family: 'Arial', bold: false, italic: false, widthFactor: 1, oblique: 0 }), measure: () => ({ advance: width, left: 0, right: width, ascent: 2.5, descent: 0 }) });
    let active = context(10); const lookup = Object.defineProperty((name: string) => doc.blocks[name], 'textGeometry', { get: () => active }) as BlockLookup;
    const immutable = doc.entities[0] as InsertEntity, first = explodeInsert(immutable, lookup); expect(explodeInsert(immutable, lookup)).toBe(first);
    active = context(20); const changed = explodeInsert(immutable, lookup), fresh = explodeInsert({ ...insert, id: 'fresh' }, lookup);
    const text = (parts: readonly unknown[]) => parts.find((part) => (part as TextEntity).type === 'text') as TextEntity;
    expect(changed).not.toBe(first); expect(text(changed).position).not.toEqual(text(first).position); expect(text(changed).position).toEqual(text(fresh).position);
    expect(entityBounds(immutable, lookup)).toEqual(entityBounds({ ...insert, id: 'fresh-bounds' }, lookup));
  });
  it('uses bounded local primitive expansion for nonuniform and mirrored references while native block definitions remain editable in DXF', () => {
    const d = ordinate(), doc = new Drawing({ blocks: { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [d], attributes: [] } } });
    const insert: InsertEntity = { id: 'insert', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 0, y: 0 }, rotation: 0, scale: 2, scaleY: 3, attributes: {} };
    const nonuniform = explodeInsert(insert, doc.lookupBlock); expect(nonuniform.some((p) => p.type === 'dimension')).toBe(false);
    const line = nonuniform.find((p): p is LineEntity => p.type === 'line')!; nearPoint(line.a, [50, 106.875]); nearPoint(line.b, [50, 210]);
    expect(explodeInsert({ ...insert, scaleY: 2, mirror: true }, doc.lookupBlock).some((p) => p.type === 'dimension')).toBe(false);
    doc.addEntities([insert]); const back = readDxf(writeDxf(doc.snapshot)); expect((back.blocks.B!.entities[0] as DimensionEntity).kind).toBe('ordinate');
  });
  it('provides finite component geometry and bounds to the existing Canvas/vector, selection and plotting paths', () => {
    const doc = new Drawing(readDxf(fixture)); for (const d of doc.entities) { expect(dimensionParts(d as DimensionEntity).length).toBeGreaterThan(1); const bounds = entityBounds(d, doc.lookupBlock)!; expect([bounds.min.x, bounds.min.y, bounds.max.x, bounds.max.y].every(Number.isFinite)).toBe(true); }
  });
  it('moves the ordinate text-center grip without confusing it with the generated TEXT baseline', () => {
    const d = ordinate({ textPosition: { x: 80, y: 90 } }); nearPoint(gripPoints(d)[3]!, [80, 90]);
    const moved = moveGrip(d, 3, { x: 100, y: 110 }) as DimensionEntity; nearPoint(moved.textPosition!, [100, 110]);
    const doc = new Drawing({ entities: [moved] }), back = readDxf(writeDxf(doc.snapshot)).entities[0] as DimensionEntity; nearPoint(back.textPosition!, [100, 110]);
    const natural = ordinate(), text = dimensionParts(natural).find((p): p is TextEntity => p.type === 'text')!;
    expect(gripPoints(natural)[3]).not.toEqual(text.position); nearPoint(gripPoints(natural)[3]!, [text.position.x - Math.sin(text.rotation) * text.height / 2, text.position.y + Math.cos(text.rotation) * text.height / 2]);
  });
  it('refuses DWG for retained ordinate entities in model space, unused blocks and paper layouts', () => {
    const d = ordinate(); for (const state of [{ entities: [d] }, { blocks: { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [d], attributes: [] } } }, { layouts: [{ ...defaultLayout('Paper'), entities: [d] }] }]) expect(dwgCompatibilityProblem(state)).toMatch(/ordinate.*choose DXF/s);
  });
  it.each([[210, '1'], [230, '-1'], [33, '2'], [51, 'NaN'], [70, '102.5'], [70, '4294967398'], [70, '-4294967194'], [70, '9007194959773798'], [71, '3'], [71, '5.0'], [41, '2']] as const)('explicitly refuses unsupported or malformed native group %s instead of discarding the dimension', (code, value) => {
    const rows = fixture.split(/\r?\n/), start = rows.findIndex((v, i) => v.trim() === '0' && rows[i + 1]?.trim() === 'DIMENSION'); let end = start + 2; while (end < rows.length && rows[end]!.trim() !== '0') end += 2;
    let index = start + 2; while (index < end && Number(rows[index]) !== code) index += 2;
    if (index < end) rows[index + 1] = value; else rows.splice(end, 0, String(code), value);
    expect(() => readDxf(rows.join('\n'))).toThrow(/Ordinate dimension cannot be imported/);
  });
  it('refuses invalid core edits atomically and does not mutate dirty/history state', () => {
    const doc = new Drawing({ entities: [ordinate()] }), state = doc.snapshot, history = doc.history();
    expect(() => doc.replaceEntities([{ ...ordinate(), ordinateAxis: 'z' as 'x' }])).toThrow(/datum axis/);
    expect(doc.snapshot).toBe(state); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(false);
    expect(() => writeDxf({ ...state, entities: [ordinate({ ordinateRotation: Infinity })] })).toThrow(/angles must be finite/);
    expect(() => doc.replaceEntities([ordinate({ p1: { x: -1e308, y: 0 }, p2: { x: 1e308, y: 0 } })])).toThrow(/finite geometry range/);
    expect(doc.snapshot).toBe(state); expect(doc.history()).toEqual(history);
    expect(() => dimensionGeometry(ordinate(), () => Infinity)).toThrow(/finite geometry range/);
  });
});
