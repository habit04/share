import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE, type DimensionEntity } from '../src/core/dimension';
import type { Entity, Layer } from '../src/core/entities';
import { dimensionParts } from '../src/core/entities';
import * as entities from '../src/core/entities';
import { polar, type Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { readDxf, writeDxf } from '../src/io/dxf';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import { colorDisplay, drawEntity, lineweightDisplay } from '../src/render/draw';
import { setTextStyles, textStyleRegistry } from '../src/render/hershey';
import { lowerDimensionStrokes, type DimensionStrokeOptions, type LoweredDimensionStrokes } from '../src/render/gpu-prototype/dimension-strokes';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const zero = { x: 0, y: 0 };
const options: DimensionStrokeOptions = { anchor: zero, widthCss: 7.3, alpha: 0.95 };
const dimension = (patch: Partial<DimensionEntity> = {}): DimensionEntity => ({
  id: 'dimension', type: 'dimension', kind: 'linear', layer: '0', color: 'ByLayer',
  p1: { x: 0, y: 0 }, p2: { x: 8, y: 1 }, linePoint: { x: 4, y: 4 }, rotation: 0,
  style: STANDARD_DIMSTYLE, ...patch,
});
const drawing = (entity: DimensionEntity, patch: Partial<DrawingState> = {}): DrawingState => ({ entities: [entity], blocks: {}, layers: [layer], currentLayer: '0', ...patch });
const accepted = (result: LoweredDimensionStrokes) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const sources = (result: LoweredDimensionStrokes): readonly Entity[] => accepted(result).parts.map((part) => part.source);
const kinds = ['linear', 'aligned', 'radius', 'diameter', 'angular'] as const;
const variant = (kind: DimensionEntity['kind'], patch: Partial<DimensionEntity> = {}) => dimension({
  kind, ...(kind === 'angular' ? { center: zero, p1: { x: 5, y: 0 }, p2: { x: 0, y: 5 }, linePoint: { x: 9, y: 9 } } : {}), ...patch,
});

type CanvasPaint = { kind: 'stroke' | 'fill'; colorCss: string; alpha: number; widthCss: number; commands: readonly unknown[] };

/** Record the source Canvas painter's actual paint order, inherited width, colors and alpha. */
function canvasPaints(entity: DimensionEntity, state: DrawingState, config: DimensionStrokeOptions = options): CanvasPaint[] {
  const output: CanvasPaint[] = [];
  const scale = 20;
  let commands: unknown[] = [];
  const stack: Array<{ globalAlpha: number; lineWidth: number; strokeStyle: string; fillStyle: string }> = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() { stack.push({ globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, strokeStyle: this.strokeStyle, fillStyle: this.fillStyle }); },
    restore() { Object.assign(this, stack.pop()!); },
    setLineDash() {},
    beginPath() { commands = []; },
    moveTo(x: number, y: number) { commands.push(['M', x / scale, -y / scale]); },
    lineTo(x: number, y: number) { commands.push(['L', x / scale, -y / scale]); },
    closePath() { commands.push(['Z']); },
    arc(x: number, y: number, radius: number, start: number, end: number, reverse = false) { commands.push(['A', x / scale, -y / scale, radius / scale, start, end, reverse]); },
    stroke() { output.push({ kind: 'stroke', colorCss: this.strokeStyle, alpha: this.globalAlpha, widthCss: this.lineWidth, commands }); },
    fill() { output.push({ kind: 'fill', colorCss: this.fillStyle, alpha: this.globalAlpha, widthCss: this.lineWidth, commands }); },
  };
  drawEntity(context as unknown as CanvasRenderingContext2D, entity, {
    scale, toScreen: (point) => ({ x: (point.x - config.anchor.x) * scale, y: -(point.y - config.anchor.y) * scale }),
  }, state.layers, () => undefined, {
    lineWidthOverride: config.widthCss, alpha: config.alpha,
    ...(config.strokeOverride !== undefined ? { strokeOverride: config.strokeOverride } : {}),
  });
  return output;
}

function expectCanvasPaints(entity: DimensionEntity, state = drawing(entity), config = options): void {
  const lowered = accepted(lowerDimensionStrokes(entity, state, config));
  const paints = canvasPaints(entity, state, config);
  expect(lowered.parts.map((part) => ({ kind: part.kind === 'fillTriangle' ? 'fill' : 'stroke', colorCss: part.colorCss, alpha: part.alpha, widthCss: part.widthCss })))
    .toEqual(paints.map(({ kind, colorCss, alpha, widthCss }) => ({ kind, colorCss, alpha, widthCss })));
  lowered.parts.forEach((part, index) => {
    if (part.kind !== 'fillTriangle') return;
    const actual = paints[index]!.commands;
    expect(actual).toHaveLength(5); // M, L, L, repeated first L, Z; one fill, no outline.
    expect(actual[3]).toEqual(['L', ...(actual[0] as [string, number, number]).slice(1)]);
    expect(actual[4]).toEqual(['Z']);
    part.points.forEach((point, pointIndex) => {
      const reference = actual[pointIndex] as [string, number, number];
      expect(Math.abs(reference[1] - point.x)).toBeLessThanOrEqual(1e-12);
      expect(Math.abs(reference[2] - point.y)).toBeLessThanOrEqual(1e-12);
    });
  });
}

const previousStyles = textStyleRegistry.styles;
afterEach(() => { vi.restoreAllMocks(); setTextStyles(previousStyles); colorDisplay.paper = false; lineweightDisplay.enabled = false; lineweightDisplay.pxPerMm = undefined; });

describe('ordered GPU dimension lowering', () => {
  it.each(kinds)('uses the corrected core and Canvas ordered layout for %s', (kind) => {
    const entity = variant(kind);
    const state = sealImmutableData(drawing(entity));
    const before = JSON.stringify(state);
    const result = accepted(lowerDimensionStrokes(entity, state, options));
    expect(sources(result)).toEqual(dimensionParts(entity));
    expectCanvasPaints(entity, state);
    expect(result.parts.some((part) => part.kind === 'fillTriangle')).toBe(true);
    expect(JSON.stringify(state)).toBe(before);
    expect(result.dimensionStyleDependency).toBe(entity.style);
  });

  it('keeps text before later arrows and composites each filled arrow only once', () => {
    const entity = dimension();
    const result = accepted(lowerDimensionStrokes(entity, drawing(entity), options));
    const textIndex = result.parts.findIndex((part) => part.kind === 'text');
    const arrowIndex = result.parts.findIndex((part) => part.kind === 'fillTriangle');
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(arrowIndex).toBeGreaterThan(textIndex);
    expect(result.parts.filter((part) => part.kind === 'fillTriangle')).toHaveLength(2);
    expect(canvasPaints(entity, drawing(entity)).filter((part) => part.kind === 'fill')).toHaveLength(2);
  });

  it('matches DIMCLRD/E/T, parent true color, explicit same-ACI overrides and parent lineweight', () => {
    const entity = dimension({ color: 3, trueColor: 0x0b34ab, lineWeight: 0.75, style: {
      ...STANDARD_DIMSTYLE, dimLineColor: 3, extLineColor: 5, textColor: 3, dimLineWeight: 100, extLineWeight: 0.01,
    } });
    const result = accepted(lowerDimensionStrokes(entity, drawing(entity), options));
    expect(new Set(result.parts.map((part) => part.colorCss))).toEqual(new Set(['#0b34ab', '#0000ff']));
    expect(result.parts.find((part) => part.kind === 'text')!.colorCss).toBe('#0b34ab');
    expect(result.parts.every((part) => part.widthCss === options.widthCss && part.alpha === 0.95)).toBe(true);
    expectCanvasPaints(entity);
  });

  it('uses current parent INSERT color and a stroke override for every dimension part', () => {
    const entity = dimension({ color: 3, style: { ...STANDARD_DIMSTYLE, textColor: 1, extLineColor: 5 } });
    const result = accepted(lowerDimensionStrokes(entity, drawing(entity), { ...options, ownColorCss: '#abcdef' }));
    expect(result.parts.filter((part) => part.source.color === 3).every((part) => part.colorCss === '#abcdef')).toBe(true);
    const override = { ...options, strokeOverride: '#aabbcc' };
    expect(accepted(lowerDimensionStrokes(entity, drawing(entity), override)).parts.every((part) => part.colorCss === '#aabbcc')).toBe(true);
    expectCanvasPaints(entity, drawing(entity), override);
  });

  it.each(['closed-blank', 'closed', 'open', 'oblique', 'dot-blank', 'none'] as const)('retains the core %s arrow/backoff behavior and paints', (arrow) => {
    const entity = dimension({ textPosition: { x: 2, y: 4 }, style: { ...STANDARD_DIMSTYLE, arrow, arrowSize: 0.4 } });
    expect(sources(lowerDimensionStrokes(entity, drawing(entity), options))).toEqual(dimensionParts(entity));
    expectCanvasPaints(entity);
  });

  it.each([
    { suppressDimLine1: true }, { suppressDimLine2: true }, { suppressDimLine1: true, suppressDimLine2: true },
    { suppressExt1: true }, { suppressExt2: true }, { arrow: 'closed-blank' as const, arrowSize: 2 },
  ])('preserves angular suppression and moved text with style %j', (stylePatch) => {
    const entity = variant('angular', { textPosition: polar(zero, Math.PI / 9, 10), style: { ...STANDARD_DIMSTYLE, ...stylePatch } });
    expect(sources(lowerDimensionStrokes(entity, drawing(entity), options))).toEqual(dimensionParts(entity));
    expectCanvasPaints(entity);
  });

  it('keeps reversed angular endpoints and zero-crossing suppression without relayout', () => {
    for (const entity of [
      variant('angular', { linePoint: polar(zero, Math.PI, 10), style: { ...STANDARD_DIMSTYLE, suppressDimLine1: true } }),
      variant('angular', { p1: polar(zero, -Math.PI / 18, 5), p2: polar(zero, Math.PI / 18, 5), linePoint: { x: 10, y: 0 }, style: { ...STANDARD_DIMSTYLE, suppressDimLine1: true } }),
    ]) {
      expect(sources(lowerDimensionStrokes(entity, drawing(entity), options))).toEqual(dimensionParts(entity));
      expectCanvasPaints(entity);
    }
  });

  it.each(['symmetrical', 'deviation', 'limits', 'basic'] as const)('preserves %s tolerances, alternate text and box part order', (tolerance) => {
    const entity = dimension({ textPosition: { x: 6, y: 7 }, textRotation: 0.4, style: {
      ...STANDARD_DIMSTYLE, tolerance, tolPlus: 0.01, tolMinus: 0.02, altUnits: true, altPlacement: 'below',
    } });
    expect(sources(lowerDimensionStrokes(entity, drawing(entity), options))).toEqual(dimensionParts(entity));
    expectCanvasPaints(entity);
  });

  it.each(kinds)('rebases every %s anchor before layout at trillion coordinates', (kind) => {
    const near = variant(kind, {
      p1: { x: 1 / 8192, y: -2 / 8192 }, p2: { x: 25 / 8192, y: 14 / 8192 },
      linePoint: { x: 13 / 8192, y: 28 / 8192 }, center: { x: -7 / 8192, y: -8 / 8192 },
      textPosition: { x: 11 / 8192, y: 13 / 8192 }, textRotation: 0.31, oblique: 0.17,
      style: { ...STANDARD_DIMSTYLE, scale: 1 / 8192 },
    });
    const anchor = { x: 1e12, y: -1e12 };
    const atWorld = (point: Point) => ({ x: anchor.x + point.x, y: anchor.y + point.y });
    const far = { ...near, p1: atWorld(near.p1), p2: atWorld(near.p2), linePoint: atWorld(near.linePoint), center: atWorld(near.center!), textPosition: atWorld(near.textPosition!) };
    const before = JSON.stringify(far);
    expect(sources(lowerDimensionStrokes(far, drawing(far), { ...options, anchor }))).toEqual(sources(lowerDimensionStrokes(near, drawing(near), options)));
    expect(JSON.stringify(far)).toBe(before);
    // A block compiler that already rebased/transformed the descendant uses zero here.
    expect(sources(lowerDimensionStrokes(near, drawing(near), { ...options, anchor: zero }))).toEqual(dimensionParts(near));
  });

  it('tracks document text-style identity and uses the current style rather than the global registry', () => {
    const entity = dimension({ style: { ...STANDARD_DIMSTYLE, textStyle: 'DimensionFont' } });
    setTextStyles({ DimensionFont: { ...STANDARD_TEXT_STYLE, name: 'DimensionFont', font: 'arial.ttf' } });
    const styles = { DimensionFont: { ...STANDARD_TEXT_STYLE, name: 'DimensionFont', font: 'txt.shx' } };
    const state = drawing(entity, { meta: { textStyles: styles } });
    expect(accepted(lowerDimensionStrokes(entity, state, options)).textStylesDependency).toBe(styles);
    expect(accepted(lowerDimensionStrokes(entity, drawing(entity), options)).textStylesDependency).toBeUndefined();
    const ttfState = drawing(entity, { meta: { textStyles: { DimensionFont: { ...styles.DimensionFont, font: 'arial.ttf' } } } });
    expect(lowerDimensionStrokes(entity, ttfState, options)).toMatchObject({ ok: false, reason: expect.stringContaining('font') });
  });

  it('follows imported DIMENSION edits, style changes, undo/redo and native DXF reopen', () => {
    const fixture = readFileSync(join(__dirname, 'fixtures', 'interchange', 'r2018-dimensions.dxf'), 'utf8');
    const doc = new Drawing(readDxf(fixture));
    const original = doc.entities.find((entity): entity is DimensionEntity => entity.type === 'dimension' && entity.kind === 'angular')!;
    const originalParts = sources(lowerDimensionStrokes(original, doc.snapshot, options));
    const edited = { ...original, textPosition: polar(original.center!, Math.PI / 9, 10), style: { ...original.style, suppressDimLine1: true } };
    doc.replaceEntities([edited]);
    const current = () => doc.entity(original.id) as DimensionEntity;
    const editedParts = sources(lowerDimensionStrokes(current(), doc.snapshot, options));
    expect(editedParts).toEqual(dimensionParts(current()));
    expect(editedParts).not.toEqual(originalParts);
    expect(accepted(lowerDimensionStrokes(current(), doc.snapshot, options)).dimensionStyleDependency).toBe(current().style);
    doc.undo();
    expect(sources(lowerDimensionStrokes(current(), doc.snapshot, options))).toEqual(originalParts);
    doc.redo();
    expect(sources(lowerDimensionStrokes(current(), doc.snapshot, options))).toEqual(editedParts);
    const reopened = readDxf(writeDxf(doc.snapshot));
    const restored = reopened.entities.find((entity): entity is DimensionEntity => entity.type === 'dimension' && entity.kind === 'angular')!;
    expect(restored.style.suppressDimLine1).toBe(true);
    expect(sources(lowerDimensionStrokes(restored, reopened, options))).toEqual(dimensionParts(restored));
  });
});

describe('all-or-nothing dimension fallback', () => {
  it.each(['arch-tick', 'dot', 'dot-small'] as const)('refuses unsafe %s arrow paint without returning partial parts', (arrow) => {
    const entity = dimension({ style: { ...STANDARD_DIMSTYLE, arrow } });
    const result = lowerDimensionStrokes(entity, drawing(entity), options);
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toHaveProperty('parts');
  });

  it.each([
    [{ annotative: true }, 'annotative'],
    [{ transparency: 100 }, 'transparency'],
    [{ kind: 'angular', center: undefined }, 'center'],
    [{ rotation: Infinity }, 'Nonfinite'],
    [{ p2: { x: NaN, y: 0 } }, 'Nonfinite'],
    [{ style: { ...STANDARD_DIMSTYLE, textHeight: Infinity } }, 'Nonfinite'],
  ] as const)('refuses unsupported or nonfinite source %j', (patch, message) => {
    const entity = dimension(patch as Partial<DimensionEntity>);
    expect(lowerDimensionStrokes(entity, drawing(entity), options)).toMatchObject({ ok: false, reason: expect.stringContaining(message) });
  });

  it('refuses entity/layer dashes and translucent layer inheritance', () => {
    const dashed = dimension({ linetype: 'DASHED' });
    expect(lowerDimensionStrokes(dashed, drawing(dashed), options)).toMatchObject({ ok: false, reason: expect.stringContaining('dashed') });
    const entity = dimension();
    expect(lowerDimensionStrokes(entity, drawing(entity, { layers: [{ ...layer, linetype: 'DASHED' }] }), options)).toMatchObject({ ok: false });
    expect(lowerDimensionStrokes(entity, drawing(entity, { layers: [{ ...layer, transparency: 128 }] }), options)).toMatchObject({ ok: false });
    expect(lowerDimensionStrokes(entity, drawing(entity), { ...options, dashed: true })).toMatchObject({ ok: false });
  });

  it.each([
    { maxParts: 0 }, { maxPoints: 0 }, { maxTextCharacters: 0 }, { maxParts: -1 },
    { maxPoints: NaN }, { widthCss: 0 }, { alpha: Infinity }, { anchor: { x: Infinity, y: 0 } },
  ])('enforces source/operation budgets and finite paint inputs %j', (patch) => {
    const entity = dimension();
    const result = lowerDimensionStrokes(entity, drawing(entity), { ...options, ...patch });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('parts');
  });

  it('bounds oversized overrides before calling core layout', () => {
    const entity = dimension({ text: 'X'.repeat(129) });
    const spy = vi.spyOn(entities, 'dimensionParts');
    expect(lowerDimensionStrokes(entity, drawing(entity), { ...options, maxTextCharacters: 128 })).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'polyline', points: [zero, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], closed: true, filled: true },
    { type: 'polyline', points: [zero, { x: 1, y: 0 }, { x: 0, y: 1 }], closed: true, filled: true, bulges: [0.1, 0, 0] },
    { type: 'text', position: zero, text: 'A', height: 1, rotation: 0, align: 'left', bold: true },
    { type: 'mtext', position: zero, text: 'A', height: 1, width: 0, rotation: 0, attachment: 1, lineSpacing: 1 },
  ])('refuses a late unsupported generated part %j without exposing earlier paints', (unsafe) => {
    const entity = dimension();
    const original = dimensionParts(entity);
    const late = { id: 'dimension:unsafe', layer: '0', color: 'ByLayer', ...unsafe } as Entity;
    vi.spyOn(entities, 'dimensionParts').mockReturnValue([...original, late]);
    const result = lowerDimensionStrokes(entity, drawing(entity), options);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('parts');
  });
});
