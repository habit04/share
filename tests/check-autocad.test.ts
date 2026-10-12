import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error Independent Node-side JavaScript oracle, also checked by typecheck:scripts.
import { compareNativeFeatures, nativeDxfRecords as readNativeRecords, nativeFeatureSignature as readNativeSignature } from '../scripts/check-autocad.mjs';

const nativeDxfRecords = readNativeRecords as (text: string) => Array<{ kind: string; section: string; block: string; groups: Array<[number, string]> }>;
const nativeFeatureSignature = readNativeSignature as (text: string, source: string) => Array<Record<string, any>>;

const widths = readFileSync(join(import.meta.dirname, 'fixtures/polyline-widths.dxf'), 'utf8').replaceAll('\r\n', '\n');
const colors = readFileSync(join(import.meta.dirname, 'fixtures/interchange/r2010-appearance.dxf'), 'utf8');
const pairs = (...values: Array<string | number>) => values.join('\n') + '\n';
const array = pairs(
  0, 'SECTION', 2, 'BLOCKS', 0, 'BLOCK', 2, 'LABEL', 10, 0, 20, 0,
  0, 'ATTDEF', 100, 'AcDbEntity', 8, '0', 62, 256, 100, 'AcDbText', 10, 999, 20, 999, 40, 1, 1, 'DEFAULT',
  100, 'AcDbAttributeDefinition', 2, 'TAG1', 70, 0, 72, 2, 74, 3, 11, 2, 21, 3,
  0, 'ENDBLK', 0, 'ENDSEC', 0, 'SECTION', 2, 'ENTITIES',
  0, 'INSERT', 100, 'AcDbEntity', 8, 'HOST', 62, 2, 420, 2386092, 440, 33554528,
  100, 'AcDbMInsertBlock', 66, 1, 2, 'LABEL', 10, 10, 20, 20, 41, 2, 42, 3, 50, 90, 70, 3, 71, 2, 44, 7, 45, 11,
  0, 'ATTRIB', 100, 'AcDbEntity', 8, '0', 62, 5, 420, 1193046, 440, 33554559,
  100, 'AcDbText', 10, 999, 20, 999, 40, 2, 1, 'OVERRIDE', 50, 90, 72, 2, 11, 120, 21, 130,
  100, 'AcDbAttribute', 2, 'TAG1', 70, 0, 74, 3,
  0, 'SEQEND', 0, 'ENDSEC', 0, 'EOF',
);

describe('independent AutoCAD native semantic oracle', () => {
  it('reads BOM/CRLF, native subclasses and block ownership without running AutoCAD', () => {
    const records = nativeDxfRecords('\uFEFF' + array.replaceAll('\n', '\r\n'));
    expect(records.find((r) => r.kind === 'ATTDEF')).toMatchObject({ section: 'BLOCKS', block: 'LABEL' });
    expect(records.find((r) => r.kind === 'ATTRIB')).toMatchObject({ section: 'ENTITIES', block: '' });
    expect(records.find((r) => r.kind === 'INSERT')?.groups.filter(([code]) => code === 100).map(([, value]) => value)).toEqual(['AcDbEntity', 'AcDbMInsertBlock']);
  });

  it('rejects incomplete pairs, invalid codes, nonfinite native widths and oversized input', () => {
    expect(() => nativeDxfRecords('0\nSECTION\n2\n')).toThrow(/incomplete/);
    expect(() => nativeDxfRecords('x\nSECTION\n')).toThrow(/integer/);
    expect(() => nativeDxfRecords('1072\ninvalid\n')).toThrow(/out of range/);
    expect(() => nativeDxfRecords(' '.repeat(8 * 1024 * 1024 + 1))).toThrow(/8 MiB/);
    expect(() => nativeFeatureSignature(widths.replace('\n41\n4\n', '\n41\nInfinity\n'), 'polyline-widths.dxf')).toThrow(/finite/);
  });

  it('checks every active tapered and bulged segment plus legacy POLYLINE defaults', () => {
    const signature = nativeFeatureSignature(widths, 'polyline-widths.dxf');
    const model = signature.filter((r) => r.kind === 'polyline' && r.scope === 'model');
    expect(model).toHaveLength(3);
    expect(model.find((r) => r.points.length === 3)?.segments).toEqual([{ start: 0, end: 4, bulge: 0 }, { start: 4, end: 2, bulge: 1 }]);
    expect(model.find((r) => r.points[0][1] === 15)?.segments).toEqual([{ start: 2, end: 3, bulge: 0 }]);
    expect(model.find((r) => r.points[0][1] === 30)?.segments).toEqual([{ start: 4, end: 4, bulge: 0 }]);
    expect(signature.find((r) => r.kind === 'polyline' && r.scope === 'WIDE')?.segments).toEqual([{ start: 2, end: 6, bulge: 0 }]);
    expect(signature.find((r) => r.kind === 'INSERT')).toMatchObject({ block: 'WIDE', position: [30, 20, 0], scale: [2, 0.5, 1] });
  });

  it('fails lost widths/bulges even when the entity counts remain unchanged', () => {
    expect(() => compareNativeFeatures(widths, widths.replace('\n41\n4\n', '\n41\n0\n'), 'polyline-widths.dxf')).toThrow(/end/);
    expect(() => compareNativeFeatures(widths, widths.replace('\n42\n1\n', '\n42\n0\n'), 'polyline-widths.dxf')).toThrow(/bulge/);
  });

  it('accepts equivalent constant/native widths and normalizes only an open polyline’s unused final segment', () => {
    const before = pairs(0, 'LWPOLYLINE', 90, 2, 70, 0, 43, 4, 10, 0, 20, 0, 10, 10, 20, 0, 40, 7, 41, 9);
    const after = pairs(0, 'LWPOLYLINE', 90, 2, 70, 0, 10, 0, 20, 0, 40, 4, 41, 4, 10, 10, 20, 0);
    expect(compareNativeFeatures(before, after, 'polyline-widths.dxf')).toMatchObject({ matched: true, nativeRecords: 1 });
    const closed = before.replace('\n70\n0\n', '\n70\n1\n');
    expect(() => compareNativeFeatures(closed, after.replace('\n70\n0\n', '\n70\n1\n'), 'polyline-widths.dxf')).toThrow();
  });

  it('keeps named identity, exact entity alpha, native ByBlock method and actual layer XDATA', () => {
    const signature = nativeFeatureSignature(colors, 'r2010-appearance.dxf');
    expect(signature.find((r) => r.kind === 'LINE' && r.rgb === 'abcdef')).toMatchObject({ name: 'Studio Book$Pearl Δ', alpha: '200007f' });
    expect(signature.find((r) => r.kind === 'LAYER' && r.layerName === 'RICH')).toMatchObject({ rgb: '123456', name: 'Studio Book$Teal 雷', alpha: '2000040' });
    expect(signature.some((r) => r.alpha === '1000000')).toBe(true);
    expect(signature.some((r) => r.alpha === '2000000')).toBe(true);
    expect(() => compareNativeFeatures(colors, colors.replace('33554559', '33554560'), 'r2010-appearance.dxf')).toThrow(/alpha/);
    expect(() => compareNativeFeatures(colors, colors.replace('33554496', '33554560'), 'r2010-appearance.dxf')).toThrow(/alpha/);
    expect(() => compareNativeFeatures(colors, colors.replace('Studio Book$Pearl Δ', 'Other$Pearl Δ'), 'r2010-appearance.dxf')).toThrow(/name/);
  });

  it('permits AutoCAD fallback ACI normalization under RGB but rejects changed RGB bytes', () => {
    const before = pairs(0, 'LINE', 8, 'HOST', 62, 1, 420, 11259375, 430, 'Studio Book$Pearl Δ', 440, 33554559, 10, 0, 20, 0, 11, 2, 21, 0);
    const after = before.replace('\n62\n1\n', '\n62\n5\n').replace('Pearl Δ', 'Pearl \\U+0394');
    expect(compareNativeFeatures(before, after, 'r2010-appearance.dxf').matched).toBe(true);
    expect(() => compareNativeFeatures(before, after.replace('11259375', '11259374'), 'r2010-appearance.dxf')).toThrow(/rgb/);
  });

  it('checks native array dimensions/spacing/scales and independent associated ATTRIB foreground/anchor', () => {
    const signature = nativeFeatureSignature(array, 'generated:minsert-attribute-overrides');
    expect(signature.find((r) => r.kind === 'INSERT')).toMatchObject({ columns: 3, rows: 2, columnSpacing: 7, rowSpacing: 11, scale: [2, 3, 1], rotation: 90, rgb: '2468ac', alpha: '2000060' });
    expect(signature.find((r) => r.kind === 'ATTRIB')).toMatchObject({ tag: 'TAG1', text: 'OVERRIDE', anchor: [120, 130, 0], horizontal: 2, vertical: 3, rgb: '123456', alpha: '200007f' });
    expect(signature.find((r) => r.kind === 'ATTDEF')).toMatchObject({ scope: 'LABEL', anchor: [2, 3, 0], horizontal: 2, vertical: 3 });
    // Group 10 is unused for this right/top justification; group 11 is authoritative.
    expect(compareNativeFeatures(array, array.replaceAll('\n10\n999\n20\n999\n', '\n10\n105\n20\n120\n'), 'generated:minsert-attribute-overrides').matched).toBe(true);
    for (const damaged of [array.replace('\n70\n3\n71\n2\n', '\n70\n1\n71\n2\n'), array.replace('\n44\n7\n', '\n44\n14\n'), array.replace('\n11\n120\n', '\n11\n121\n'), array.replace('33554559', '33554528'), array.replace('\n74\n3\n0\nSEQEND', '\n74\n0\n0\nSEQEND')]) {
      expect(() => compareNativeFeatures(array, damaged, 'generated:minsert-attribute-overrides')).toThrow();
    }
  });

  it('rejects broken transparency encodings instead of treating them as opaque', () => {
    expect(() => nativeFeatureSignature(array.replace('33554559', '33554688'), 'generated:minsert-attribute-overrides')).toThrow(/invalid method/);
    expect(() => nativeFeatureSignature(colors.replace('33554496', 'NaN'), 'r2010-appearance.dxf')).toThrow(/layer alpha/);
  });

  it('checks both authoritative FIT anchors and justified text placement through native font normalization', () => {
    const text = pairs(0, 'TEXT', 8, '0', 10, 0, 20, 0, 40, 2, 1, 'FIT', 72, 5, 73, 0, 11, 0, 21, 10);
    expect(nativeFeatureSignature(text, 'r2000-text-justification.dxf')[0]).toMatchObject({ horizontal: 5, vertical: 0, anchor: [0, 10, 0], firstAnchor: [0, 0, 0], height: 2 });
    expect(() => compareNativeFeatures(text, text.replace('\n21\n10\n', '\n21\n11\n'), 'r2000-text-justification.dxf')).toThrow(/anchor/);
    expect(() => compareNativeFeatures(text, text.replace('\n20\n0\n', '\n20\n1\n'), 'r2000-text-justification.dxf')).toThrow(/firstAnchor/);
    const aligned = text.replace('FIT', 'ALIGNED').replace('\n72\n5\n', '\n72\n3\n');
    const alignedNormalized = aligned.replace('\n40\n2\n', '\n40\n3\n') + pairs(50, 90);
    expect(compareNativeFeatures(aligned, alignedNormalized, 'r2000-text-justification.dxf').matched).toBe(true);
    expect(nativeFeatureSignature(alignedNormalized, 'r2000-text-justification.dxf')[0]).toMatchObject({ rotation: 90, fittedWidth: 10, fittedHeightPerFontAdvance: 10 });
    expect(() => compareNativeFeatures(aligned, aligned + pairs(41, 2), 'r2000-text-justification.dxf')).toThrow(/fittedHeightPerFontAdvance/);
    expect(() => compareNativeFeatures(text, text.replace('\n40\n2\n', '\n40\n3\n'), 'r2000-text-justification.dxf')).toThrow(/height/);
    expect(compareNativeFeatures(text, text + pairs(50, 90, 41, 2.142857142857143), 'r2000-text-justification.dxf').matched).toBe(true);
    const style = pairs(0, 'STYLE', 2, 'Standard', 3, 'txt', 4, '', 40, 0, 41, 1, 50, 0, 71, 0);
    expect(() => compareNativeFeatures(style + aligned, style.replace('\n3\ntxt\n', '\n3\nother.shx\n') + aligned, 'r2000-text-justification.dxf')).toThrow(/font/);
    expect(() => nativeFeatureSignature(aligned.replace('\n40\n2\n', '\n40\n0\n'), 'r2000-text-justification.dxf')).toThrow(/positive/);
  });
});
