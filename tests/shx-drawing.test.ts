import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Drawing } from '../src/core/document';
import { entityBounds, textCorners, mtextParts, dimensionParts, type TextEntity, type MTextEntity, type DimensionEntity } from '../src/core/entities';
import { metricTextPlacement } from '../src/core/text-metrics';
import { STANDARD_TEXT_STYLE, textStylesOf } from '../src/io/encoding';
import { readDxf, writeDxf } from '../src/io/dxf';
import { DrawingShxResources } from '../src/render/drawing-shx';
import { drawEntity } from '../src/render/draw';
import { shxTextPaths } from '../src/render/shx-paths';
import { capturedPdfLookup } from '../src/app/pdf-fonts';
import { capturedPlotLookup } from '../src/app/plot-fonts';
import { drawingContext, vectorPdf, type PdfPageSpec } from '../src/io/pdf-vector';
import { STANDARD_DIMSTYLE } from '../src/core/dimension';
import { fontRecords, shxFixture } from './helpers/shx-fixture';

const styles = { FACE: { ...STANDARD_TEXT_STYLE, name: 'FACE', font: 'authored.shx' } };
const resource = (bytes = shxFixture(), path = 'C:\\private\\authored.shx') => {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return { bytes, resolvedPath: path, sha256, resourceId: JSON.stringify([path, sha256]) };
};
const text = (extra: Partial<TextEntity> = {}): TextEntity => ({ id: 't', type: 'text', layer: '0', color: 1, style: 'FACE', text: 'A', position: { x: 0, y: 0 }, height: 10, rotation: 0, align: 'left', ...extra });
async function loaded() { const fonts = new DrawingShxResources(); await fonts.load(resource()); return { fonts, geometry: fonts.geometry(styles) }; }
const closePoints = (actual: readonly { x: number; y: number }[], expected: readonly (readonly [number, number])[]) => {
  expect(actual).toHaveLength(expected.length); actual.forEach((p, i) => { expect(p.x).toBeCloseTo(expected[i]![0], 10); expect(p.y).toBeCloseTo(expected[i]![1], 10); });
};

describe('authored native SHX drawing geometry', () => {
  // Native COMPILE/TEXTBOX proves these glyph ink/pen distinctions independently of the renderer.
  it.each([
    ['A', 'center', -4], ['A', 'right', -8], [' A', 'center', -10], [' A', 'right', -14],
    ['A ', 'center', -8], ['A ', 'right', -16], ['A%%032', 'right', -16], ['A %%u', 'center', -8], [' A ', 'center', -11], [' A ', 'right', -22],
    [' ', 'center', -3], ['  ', 'right', -12], ['C', 'center', 0], ['C', 'right', -5],
  ] as const)('positions %j %s from native ink/logical-space rules', async (value, align, offset) => {
    const { geometry } = await loaded(); expect(metricTextPlacement(text({ text: value, align }), geometry).offset).toBeCloseTo(offset, 10);
  });
  it.each([['A', 12.5], ['A ', 6.25], [' ', 100 / 6]] as const)('fits %j using native width', async (value, width) => {
    const { geometry } = await loaded();
    const base = text({ text: value, justification: { horizontal: 5, vertical: 0 }, alignmentPoint: { x: 100, y: 0 } });
    const fitted = metricTextPlacement(base, geometry).text;
    expect(fitted.height).toBe(10); expect(fitted.widthFactor).toBeCloseTo(width, 10);
    const aligned = metricTextPlacement({ ...base, justification: { horizontal: 3, vertical: 0 } }, geometry).text;
    expect(aligned.height).toBeCloseTo(width * 10, 10); expect(aligned.widthFactor).toBe(1);
  });
  it('uses header descent for BOTTOM and actual ink center for MIDDLE', async () => {
    const { geometry } = await loaded();
    expect(metricTextPlacement(text({ justification: { horizontal: 0, vertical: 1 } }), geometry).text.position.y).toBe(2);
    expect(metricTextPlacement(text({ text: 'C', justification: { horizontal: 4, vertical: 0 } }), geometry).text.position.y).toBeCloseTo(-5, 10);
    expect(metricTextPlacement(text({ text: ' ', justification: { horizontal: 4, vertical: 0 } }), geometry).text.position.y).toBe(0);
  });
  it('retains explicit entity width/oblique defaults and applies shear outside width factor', async () => {
    const { fonts } = await loaded(), definitions = { FACE: { ...styles.FACE, widthFactor: 0.8, oblique: 10 } }, geometry = fonts.geometry(definitions);
    closePoints(textCorners(text({ widthFactor: 1, oblique: 0 }), geometry), [[0, 0], [8, 0], [8, 10], [0, 10]]);
    const t = text({ align: 'right', widthFactor: 0.5, oblique: Math.PI / 4 }), placed = metricTextPlacement(t, geometry);
    expect(placed.offset).toBe(-8);
    closePoints(textCorners(t, geometry), [[-4, 0], [0, 0], [10, 10], [6, 10]]);
    const run = geometry.shxRun!(t.text, t.height, placed.appearance)!;
    expect(run.ok).toBe(true);
    if (run.ok) closePoints([shxTextPaths(run, placed.text, placed.offset)[0]!.to], [[8, 10]]);
  });
  it('refreshes bounds, MTEXT and dimensions without changing saved state or history', async () => {
    const fonts = new DrawingShxResources(), doc = new Drawing({ entities: [text()], meta: { textStyles: styles } }, (s) => fonts.geometry(s));
    const m: MTextEntity = { id: 'm', type: 'mtext', layer: '0', color: 1, style: 'FACE', text: 'AA AA', position: { x: 0, y: 0 }, height: 10, width: 21, rotation: 0, attachment: 1, lineSpacing: 1 };
    const d: DimensionEntity = { id: 'd', type: 'dimension', kind: 'linear', layer: '0', color: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, linePoint: { x: 0, y: 20 }, rotation: 0, style: { ...STANDARD_DIMSTYLE, textStyle: 'FACE' }, text: 'AA' };
    const key = doc.lookupBlock.textGeometry!.cacheKey, before = entityBounds(doc.entities[0]!, doc.lookupBlock), oldParts = mtextParts(m, doc.lookupBlock.textGeometry), oldDim = dimensionParts(d, doc.lookupBlock.textGeometry);
    const snapshot = doc.snapshot, history = doc.history(); await fonts.load(resource());
    expect(doc.lookupBlock.textGeometry!.cacheKey).not.toBe(key); expect(entityBounds(doc.entities[0]!, doc.lookupBlock)).not.toEqual(before);
    expect(mtextParts(m, doc.lookupBlock.textGeometry)).not.toBe(oldParts); expect(dimensionParts(d, doc.lookupBlock.textGeometry)).not.toBe(oldDim);
    expect(doc.snapshot).toBe(snapshot); expect(doc.history()).toEqual(history); expect(doc.dirty).toBe(false);
    const saved = writeDxf(doc.snapshot), reopened = readDxf(saved);
    expect(textStylesOf(reopened).FACE!.font).toBe('authored.shx'); expect(saved).not.toContain('resourceId'); expect(saved).not.toContain('C:\\private');
  });
  it('keeps fallback for BigFont, vertical and mirrored generation flags', async () => {
    const { fonts } = await loaded();
    for (const patch of [{ bigFont: 'big.shx' }, { flags: 4 }, { generation: 2 }, { generation: 4 }]) {
      expect(fonts.geometry({ FACE: { ...styles.FACE, ...patch } }).resolve(text())).not.toHaveProperty('shxResourceId');
    }
  });
  it('uses font-specific diameter controls without changing literal Unicode identity', async () => {
    const fonts = new DrawingShxResources();
    await fonts.load(resource(shxFixture('unifont', [...fontRecords, { code: 0x2205, program: [8, 3, 0, 2, 8, 1, 0, 0] }])));
    const geometry = fonts.geometry(styles), face = geometry.resolve(text());
    expect(geometry.measure('%%c', 10, face).advance).toBe(4);
    expect(geometry.shxRun!('⌀', 10, face)).toMatchObject({ ok: false });
  });
});

describe('captured SHX Canvas and PDF paths', () => {
  const page = (entities: readonly TextEntity[]): PdfPageSpec => ({ width: 200, height: 200, label: 'SHX', groups: [{ entities, k: 1, e: 20, f: 20, hidden: new Set(), ltUnit: 1, annoFactor: 1 }] });
  it('paints actual paths and restores Canvas state even when a glyph stroke throws', async () => {
    const { geometry } = await loaded(), moves: number[][] = [], curves: number[][] = []; let depth = 0;
    const ctx = new Proxy({ lineWidth: 1, globalAlpha: 1 }, { get(target, p) {
      if (p === 'save') return () => { depth++; }; if (p === 'restore') return () => { depth--; };
      if (p === 'moveTo') return (...values: number[]) => moves.push(values); if (p === 'bezierCurveTo') return (...values: number[]) => curves.push(values);
      if (p === 'fillText') return () => { throw new Error('SHX must not use Canvas glyph substitution'); };
      return p in target ? target[p as keyof typeof target] : () => {};
    } }) as unknown as CanvasRenderingContext2D;
    const lookup = Object.assign(() => undefined, { textGeometry: geometry }), layers = new Drawing().layers, tf = { scale: 1, toScreen: (p: { x: number; y: number }) => ({ x: p.x, y: -p.y }) };
    drawEntity(ctx, text(), tf, layers, lookup); expect(moves.some((p) => p[0] === 0 && p[1] === 0)).toBe(true); expect(depth).toBe(0);
    drawEntity(ctx, text({ text: 'C' }), tf, layers, lookup); expect(curves).toHaveLength(4); expect(depth).toBe(0);
    const original = ctx.stroke; ctx.stroke = () => { throw new Error('stroke failure'); };
    expect(() => drawEntity(ctx, text(), tf, layers, lookup)).toThrow('stroke failure'); expect(depth).toBe(0); ctx.stroke = original;
  });
  it('captures decoded programs and emits vector paths through the PDF preparation route', async () => {
    const { fonts } = await loaded(), doc = new Drawing({ entities: [text({ text: 'AC' })], meta: { textStyles: styles } });
    const geometry = fonts.capture(styles, true), lookup = await capturedPlotLookup(doc.snapshot, geometry);
    const pending = capturedPdfLookup(doc.snapshot, async () => ({ font: null }), [page(doc.entities as TextEntity[]).groups[0]!], lookup);
    await fonts.load(resource(shxFixture('unifont', fontRecords.map((r) => r.code === 65 ? { ...r, program: [8, 1, 1, 2, 8, 1, -1, 0] } : r)), 'C:\\other\\authored.shx'));
    const result = await pending, context = { ...drawingContext(doc.snapshot, result.lookup), textGeometry: result.geometry };
    const pdf = new TextDecoder('latin1').decode(vectorPdf([page(doc.entities as TextEntity[])], context, { mode: 'color', lineweights: true, usePlotStyles: false }, 'SHX'));
    expect(pdf).toContain('20 20 m 24 30 l'); expect(pdf).toMatch(/ c /); expect(pdf).not.toMatch(/\bTj\b/); expect(pdf).not.toContain('FontFile');
    expect(result.geometry!.measure('A', 10, result.geometry!.resolve(text())).right).toBe(8);
    expect(fonts.geometry(styles).measure('A', 10, fonts.geometry(styles).resolve(text())).right).toBe(1); expect(doc.dirty).toBe(false);
  });
  it.each([1, 2, 3, 4])('reports a vector substitute for restricted/unverified header type %i', async (type) => {
    const fonts = new DrawingShxResources(); await fonts.load(resource(shxFixture('unifont', fontRecords.map((r) => r.code === 0 ? { ...r, program: [10, 2, 2, 0, type, 0] } : r))));
    const doc = new Drawing({ entities: [text()], meta: { textStyles: styles } }), geometry = fonts.capture(styles, true), face = geometry.resolve(text());
    expect(fonts.geometry(styles).shxRun!('A', 10, fonts.geometry(styles).resolve(text()))).toMatchObject({ ok: true });
    expect(geometry.shxRun!('A', 10, face)).toMatchObject({ ok: false }); expect([...geometry.fontIssues!]).toHaveLength(1);
    const lookup = Object.assign(() => undefined, { textGeometry: geometry }), pdf = new TextDecoder().decode(vectorPdf([page([text()])], drawingContext(doc.snapshot, lookup), { mode: 'color', lineweights: true, usePlotStyles: false }, 'substitute'));
    expect(pdf).not.toContain('FontFile'); expect(geometry.fontIssues!.size).toBe(1);
  });
});
