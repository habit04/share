import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Drawing, DEFAULT_HEADER, type DrawingState } from '../src/core/document';
import { defaultLayout } from '../src/core/layouts';
import { scaleEntityBy, blockTransform } from '../src/core/entities';
import {
  findDimStyle, resolveDimStyle, STANDARD_DIMSTYLE, withDimStyle,
  type DimensionEntity, type DimStyle,
} from '../src/core/dimension';
import { readDxf, writeDxf } from '../src/io/dxf';
import { dstylePairs, readDimension, readDimStyleFromEntity } from '../src/io/dxf/read-annotations';
import { objects, tokenize, type Obj } from '../src/io/dxf/groups';
import { chainDimension, dimstyleCommandTool } from '../src/tools/dimension';
import { matchProperties } from '../src/tools/drafting-modify';
import { drive, fakeContext } from './fake-context';

const named: DimStyle = { ...STANDARD_DIMSTYLE, name: 'Test' };
const dimension = (style: DimStyle = named, extra: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: 'dimension', layer: '0', color: 'ByLayer', type: 'dimension', kind: 'linear',
  p1: { x: 0, y: 0 }, p2: { x: 4, y: 0 }, linePoint: { x: 2, y: 1 }, rotation: 0,
  style, ...extra,
});
const drawing = (d: DimensionEntity) => withDimStyle({ ...new Drawing().snapshot, entities: [d] }, named, false);
const dimensions = (s: DrawingState) => [
  ...s.entities, ...Object.values(s.blocks).flatMap((b) => b.entities), ...(s.layouts ?? []).flatMap((l) => l.entities),
].filter((e): e is DimensionEntity => e.type === 'dimension');
const nativeDimensions = (text: string) => {
  const pairs = tokenize(text);
  return objects(pairs, 0, pairs.length).filter((o) => o.kind === 'DIMENSION');
};
const native = (overrides: Array<[number, number | string]>, inherited = named, textStyleHandles?: Map<string, string>, extensions: Array<[string, string]> = []) => {
  const o: Obj = { kind: 'DIMENSION', groups: [
    { code: 70, value: '0' }, { code: 3, value: inherited.name },
    { code: 13, value: '0' }, { code: 23, value: '0' },
    { code: 14, value: '4' }, { code: 24, value: '0' },
    { code: 10, value: '2' }, { code: 20, value: '1' },
    { code: 1001, value: 'ACAD' }, { code: 1000, value: 'DSTYLE' }, { code: 1002, value: '{' },
    ...overrides.flatMap(([code, value]) => [
      { code: 1070, value: String(code) },
      { code: code === 340 ? 1005 : typeof value === 'string' ? 1000 : 1040, value: String(value) },
    ]),
    { code: 1002, value: '}' },
    ...(extensions.length ? [{ code: 1001, value: 'JCAD_DIMSTYLE' }, ...extensions.flatMap(([name, value]) => [{ code: 1000, value: name }, { code: 1000, value }])] : []),
  ] };
  const style = readDimStyleFromEntity(o, new Map([[inherited.name.toUpperCase(), inherited]]), named, textStyleHandles);
  return readDimension(o, { id: 'dimension', layer: '0', color: 'ByLayer' }, style, textStyleHandles) as DimensionEntity;
};

describe('dimension override presence across named style redefinitions', () => {
  it('retains native fixture overrides through matching styles, all spaces, undo/redo and repeated DXF reopen', () => {
    const imported = readDxf(readFileSync(join(__dirname, 'fixtures/interchange/r2018-dimensions.dxf'), 'utf8'));
    const original = imported.entities.find((e): e is DimensionEntity => e.type === 'dimension' && e.p1.y === 120)!;
    const base = findDimStyle(imported, 'ISO-25')!;
    expect(original.style).toMatchObject({ textHeight: 5, decimals: 0 });
    expect(original.styleOverrides).toMatchObject({ DIMTXT: 5, DIMDEC: 0 });
    const doc = new Drawing({ ...imported,
      blocks: { ...imported.blocks, DETAIL: { name: 'DETAIL', basePoint: { x: 0, y: 0 }, attributes: [], entities: [{ ...original, id: 'block-dimension' }] } },
      layouts: [{ ...defaultLayout('Paper'), pristine: false, entities: [{ ...original, id: 'paper-dimension' }] }],
      space: { layout: 'Paper' },
    });
    const before = doc.snapshot;
    doc.transactDrawing((s) => withDimStyle(s, { ...base, textHeight: 5, decimals: 0 }));
    const equal = doc.snapshot;
    expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot).toBe(equal);
    let reopened = readDxf(writeDxf(equal));
    // Equal values are still native ACAD DSTYLE groups, not only JCad state metadata.
    const nativeOverrides = nativeDimensions(writeDxf(equal)).filter((o) => o.groups.some((p) => p.code === 23 && p.value === '120'));
    expect(nativeOverrides).toHaveLength(3);
    for (const o of nativeOverrides) expect(dstylePairs(o)).toEqual(expect.arrayContaining([[140, '5'], [271, '0']]));
    reopened = readDxf(writeDxf(reopened));
    const later = new Drawing(reopened);
    const matched = later.snapshot;
    later.transactDrawing((s) => withDimStyle(s, { ...base, textHeight: 3, decimals: 1 }));
    const overridden = dimensions(later.snapshot).filter((d) => d.p1.y === 120);
    expect(overridden).toHaveLength(3);
    for (const d of overridden) expect(d.style).toMatchObject({ textHeight: 5, decimals: 0 });
    expect(findDimStyle(later.snapshot, 'ISO-25')).toMatchObject({ textHeight: 3, decimals: 1 });
    expect(later.undo()).toBe(true);
    expect(later.snapshot).toBe(matched);
    expect(later.redo()).toBe(true);
    for (const d of dimensions(later.snapshot).filter((e) => e.p1.y === 120)) expect(d.style.textHeight).toBe(5);
  });

  it('records legacy effective-value overrides before the named style temporarily adopts them', () => {
    const legacy = dimension({ ...named, textHeight: 5, suppressExt1: true });
    expect(legacy.styleOverrides).toBeUndefined();
    const equal = withDimStyle(drawing(legacy), { ...named, textHeight: 5, suppressExt1: true });
    expect((equal.entities[0] as DimensionEntity).styleOverrides).toMatchObject({ DIMTXT: 5, DIMSE1: 1 });
    const later = withDimStyle(readDxf(writeDxf(equal)), { ...named, textHeight: 3, suppressExt1: false });
    expect((later.entities[0] as DimensionEntity).style).toMatchObject({ textHeight: 5, suppressExt1: true });
  });

  it('preserves explicit equal false, zero, empty string and text-height overrides', () => {
    const d = native([[140, 0.18], [75, 0], [176, 0], [3, '']]);
    expect(d.styleOverrides).toEqual({ DIMTXT: 0.18, DIMSE1: 0, DIMCLRD: 0, DIMPOST: '' });
    const equal = readDxf(writeDxf(drawing(d)));
    const later = withDimStyle(equal, { ...named, textHeight: 2, suppressExt1: true, dimLineColor: 3, post: 'prefix <>' });
    expect(resolveDimStyle((later.entities[0] as DimensionEntity).style)).toMatchObject({ textHeight: 0.18, suppressExt1: false, post: '' });
    expect((later.entities[0] as DimensionEntity).style.dimLineColor).toBeUndefined();
    const codes = dstylePairs(nativeDimensions(writeDxf(later))[0]!);
    expect(codes).toEqual(expect.arrayContaining([[140, '0.18'], [75, '0'], [176, '0'], [3, '']]));
  });

  it('preserves a partial DIMTOH override while allowing DIMTIH to inherit each replacement', () => {
    const d = native([[74, 0]]);
    let next = withDimStyle(drawing(d), { ...named, textAlign: 'horizontal' });
    expect(resolveDimStyle((next.entities[0] as DimensionEntity).style).textAlign).toBe('iso');
    const pairs = dstylePairs(nativeDimensions(writeDxf(next))[0]!);
    expect(pairs).toEqual([[74, '0']]);
    next = withDimStyle(readDxf(writeDxf(next)), { ...named, textAlign: 'aligned' });
    expect(resolveDimStyle((next.entities[0] as DimensionEntity).style).textAlign).toBe('aligned');
    expect((next.entities[0] as DimensionEntity).styleOverrides).toEqual({ DIMTOH: 0 });
  });

  it('preserves native equal DIMTXSTY handles as resolved style names and regenerates valid handles', () => {
    const d = native([[340, 'A1']], named, new Map([['A1', 'Standard']]));
    expect(d.styleOverrides).toEqual({ DIMTXSTY: 'Standard' });
    const reopened = readDxf(writeDxf(drawing(d)));
    expect((reopened.entities[0] as DimensionEntity).styleOverrides).toMatchObject({ DIMTXSTY: 'Standard' });
    const later = withDimStyle(reopened, { ...named, textStyle: 'Other' });
    expect(resolveDimStyle((later.entities[0] as DimensionEntity).style).textStyle).toBe('Standard');
    const pairs = dstylePairs(nativeDimensions(writeDxf(later))[0]!);
    expect(pairs.find(([code]) => code === 340)?.[1]).toMatch(/^[0-9A-F]+$/);
  });

  it('keeps inherited legacy fields inherited and excludes unknown codes or unresolved handles', () => {
    const d = native([[999, 'retained by another workstream'], [340, 'DEAD']]);
    expect(d.styleOverrides).toEqual({});
    const next = withDimStyle(drawing(d), { ...named, textHeight: 3, suppressExt1: true });
    expect((next.entities[0] as DimensionEntity).style.textHeight).toBe(3);
    expect((next.entities[0] as DimensionEntity).style.suppressExt1).toBe(true);
    expect(dstylePairs(nativeDimensions(writeDxf(next))[0]!)).toEqual([]);
  });

  it('DIMSTYLE Apply clears an older override before assigning the current settings', () => {
    const d = native([[140, 5]]);
    const doc = new Drawing(drawing(d));
    doc.setHeader({ ...DEFAULT_HEADER, dimStyle: named });
    drive(dimstyleCommandTool('Apply'), fakeContext(doc), [{ select: [d.id] }]);
    expect((doc.entities[0] as DimensionEntity).styleOverrides).toBeUndefined();
    doc.transactDrawing((s) => withDimStyle(s, { ...named, textHeight: 3 }));
    expect((doc.entities[0] as DimensionEntity).style.textHeight).toBe(3);
    doc.undo();
    doc.undo();
    expect((doc.entities[0] as DimensionEntity).styleOverrides).toMatchObject({ DIMTXT: 5 });
    expect((doc.entities[0] as DimensionEntity).style.textHeight).toBe(5);
  });

  it('preserves native DIMTIH=0 when the effective ISO display mode normalizes the two flags', () => {
    const horizontal = { ...named, textAlign: 'horizontal' as const };
    const d = native([[73, 0]], horizontal);
    const source = withDimStyle({ ...drawing(d), header: { ...DEFAULT_HEADER, dimStyle: horizontal } }, horizontal, false);
    expect(resolveDimStyle(d.style).textAlign).toBe('iso');
    const reopened = readDxf(writeDxf(source));
    expect(dstylePairs(nativeDimensions(writeDxf(reopened))[0]!)).toEqual([[73, '0']]);
    const later = withDimStyle(reopened, { ...named, textAlign: 'aligned' });
    expect(resolveDimStyle((later.entities[0] as DimensionEntity).style).textAlign).toBe('aligned');
    expect((later.entities[0] as DimensionEntity).styleOverrides).toEqual({ DIMTIH: 0 });
  });

  it('generic immutable style edits replace both aliases of a normalized text-alignment field', () => {
    const horizontal = { ...named, textAlign: 'horizontal' as const };
    const original = native([[73, 0]], horizontal);
    const doc = new Drawing(withDimStyle(drawing(original), horizontal, false));
    doc.replaceEntities([{ ...original, style: { ...original.style, textAlign: 'horizontal' } }]);
    const edited = writeDxf(doc.snapshot);
    expect(dstylePairs(nativeDimensions(edited)[0]!)).toEqual(expect.arrayContaining([[73, '1'], [74, '1']]));
    const later = withDimStyle(readDxf(edited), { ...named, textAlign: 'aligned' });
    expect(resolveDimStyle((later.entities[0] as DimensionEntity).style).textAlign).toBe('horizontal');
    doc.undo();
    expect((doc.entities[0] as DimensionEntity).styleOverrides).toEqual({ DIMTIH: 0 });
    expect(resolveDimStyle((doc.entities[0] as DimensionEntity).style).textAlign).toBe('iso');
  });

  it('normalizes malformed fractional integer overrides before emitting native integer XDATA', () => {
    const d = native([[75, 0.5], [77, 0.8], [371, 12.5], [73, 0], [74, 1], [78, 4.5]]);
    expect(d.styleOverrides).toMatchObject({ DIMSE1: 1, DIMTAD: 1, DIMLWD: 13, DIMTIH: 0, DIMTOH: 1, DIMZIN: 4 });
    const exported = writeDxf(drawing(d));
    const o = nativeDimensions(exported)[0]!;
    expect(dstylePairs(o)).toEqual(expect.arrayContaining([[75, '1'], [77, '1'], [371, '13'], [73, '0'], [74, '1'], [78, '4']]));
    for (const p of o.groups.filter((p) => p.code === 1070)) expect(Number.isInteger(Number(p.value))).toBe(true);
    const reopened = readDxf(exported).entities[0] as DimensionEntity;
    expect(resolveDimStyle(reopened.style)).toMatchObject({ suppressExt1: true, textVertical: 'above', dimLineWeight: 0.13, suppressLeadingZeros: true });
    expect(reopened.styleOverrides).toMatchObject({ DIMTIH: 0, DIMTOH: 1 });
  });

  it('records legacy overrides even if the replacement style is the same object as the effective style', () => {
    const legacy = dimension({ ...named, textHeight: 5 });
    const equal = withDimStyle(drawing(legacy), legacy.style);
    expect((equal.entities[0] as DimensionEntity).styleOverrides).toEqual({ DIMTXT: 5 });
    expect((withDimStyle(equal, { ...named, textHeight: 3 }).entities[0] as DimensionEntity).style.textHeight).toBe(5);
  });

  it('does not turn a first-arrow-only override into an inherited second-arrow override', () => {
    const d = native([], named, undefined, [['DIMBLK1', '.']]);
    const first = withDimStyle(drawing(d), { ...named, arrow: 'dot' });
    expect((first.entities[0] as DimensionEntity).styleOverrides).toEqual({ DIMBLK1: '' });
    const next = withDimStyle(readDxf(writeDxf(first)), { ...named, arrow: 'dot', arrow2: 'open' });
    expect(resolveDimStyle((next.entities[0] as DimensionEntity).style)).toMatchObject({ arrow: 'closed-filled', arrow2: 'open' });
    expect((next.entities[0] as DimensionEntity).styleOverrides).toEqual({ DIMBLK1: '' });
  });

  it('ignores malformed extension values when recording override presence', () => {
    const d = native([], named, undefined, [['TOLERANCE', 'bogus'], ['ALTPLACEMENT', 'bogus'], ['DIMBLK1', 'unresolved block']]);
    expect(d.styleOverrides).toEqual({});
    const next = withDimStyle(drawing(d), { ...named, tolerance: 'limits', altPlacement: 'below', arrow: 'dot' });
    expect(resolveDimStyle((next.entities[0] as DimensionEntity).style)).toMatchObject({ tolerance: 'limits', altPlacement: 'below', arrow: 'dot' });
  });

  it('does not treat object prototype names as supported native override variables', () => {
    const d = dimension(named, { styleOverrides: JSON.parse('{"toString":"unknown","__proto__":"unknown"}') as Record<string, string> });
    const next = withDimStyle(drawing(d), { ...named, textHeight: 3 });
    expect((next.entities[0] as DimensionEntity).styleOverrides).toEqual({});
    expect((next.entities[0] as DimensionEntity).style.textHeight).toBe(3);
    expect(dstylePairs(nativeDimensions(writeDxf(next))[0]!)).toEqual([]);
  });

  it.each(['scale', 'block'] as const)('records a %s transform scale override and preserves it through matching/redefined styles', (mode) => {
    const original = native([]);
    const scaled = (mode === 'scale' ? scaleEntityBy(original, { x: 0, y: 0 }, 2) : blockTransform(original, (p) => ({ x: p.x * 2, y: p.y * 2 }), 0, 2, 2, false)) as DimensionEntity;
    expect(scaled.styleOverrides).toEqual({ DIMSCALE: 2 });
    const doc = new Drawing(drawing(original));
    doc.replaceEntities([scaled]);
    doc.transactDrawing((s) => withDimStyle(s, { ...named, scale: 2 }));
    const next = withDimStyle(readDxf(writeDxf(doc.snapshot)), { ...named, scale: 3 });
    expect((next.entities[0] as DimensionEntity).style.scale).toBe(2);
    doc.undo();
    doc.undo();
    expect((doc.entities[0] as DimensionEntity).styleOverrides).toEqual({});
    expect((doc.entities[0] as DimensionEntity).style.scale).toBe(1);
  });

  it.each([false, true])('MATCHPROP copies source override presence and values (overridden=%s)', (overridden) => {
    const source = native(overridden ? [[140, 4]] : []);
    const target = native([[75, 1], [140, 5]]);
    const matched = matchProperties(source, target) as DimensionEntity;
    expect(matched.styleOverrides).toEqual(source.styleOverrides);
    const equal = withDimStyle(drawing(matched), { ...named, textHeight: 4 });
    const later = withDimStyle(readDxf(writeDxf(equal)), { ...named, textHeight: 3, suppressExt1: false });
    expect((later.entities[0] as DimensionEntity).style.textHeight).toBe(overridden ? 4 : 3);
    expect(resolveDimStyle((later.entities[0] as DimensionEntity).style).suppressExt1).toBe(false);
  });

  it('continued dimensions reset source override presence when current settings replace the source style', () => {
    const source = native([[140, 5]]);
    const continued = chainDimension(source, 'continue', source.p2, { x: 8, y: 0 }, named);
    expect(continued.styleOverrides).toBeUndefined();
    const later = withDimStyle(drawing(continued), { ...named, textHeight: 3 });
    expect((later.entities[0] as DimensionEntity).style.textHeight).toBe(3);
  });
});
