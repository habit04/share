import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity, Layer, LineEntity, TextEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import { sealImmutableData } from '../src/core/immutable-data';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import { colorDisplay, drawEntity, lineweightDisplay } from '../src/render/draw';
import { setTextStyles, textStyleRegistry } from '../src/render/hershey';
import * as hershey from '../src/render/hershey';
import type { Gpu2DOverlay, Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { lowerStrokeScene, type LocalStrokePath, type LoweredStrokeScene } from '../src/render/gpu-prototype/stroke-scene';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 10, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const line = (id = 'line'): LineEntity => ({ id, type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } });
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'Ag %%c', height: 1, rotation: 0, align: 'left', ...patch });
const insert = (block: string, patch: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'insert', type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 7, y: 11 }, scale: 2, rotation: 0, attributes: {}, ...patch });
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}, layers: readonly Layer[] = [layer]): DrawingState => ({ entities, blocks, layers, currentLayer: '0' });
const accepted = (result: LoweredStrokeScene) => {
  if (!result.ok) throw new Error(result.reason);
  return result;
};
const paths = (result: LoweredStrokeScene): readonly LocalStrokePath[] => accepted(result).operations.flatMap((operation) => operation.paths);
const strokePoints = (result: LoweredStrokeScene): readonly (readonly Point[])[] => paths(result).map((path) => {
  if (path.kind !== 'path') throw new Error('Expected text path');
  return path.points;
});

/** Inspect the existing Canvas painter's actual subpaths, not a copied glyph formula. */
function canvasTextPaths(entity: TextEntity, state = drawing([entity]), scale = view.scale): Point[][] {
  const output: Point[][] = [];
  let current: Point[][] = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() {}, restore() {}, setLineDash() {},
    beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push([{ x, y }]); },
    lineTo(x: number, y: number) { current[current.length - 1]!.push({ x, y }); },
    stroke() { output.push(...current); },
  };
  drawEntity(context as unknown as CanvasRenderingContext2D, entity, { scale, toScreen: (point) => ({ x: point.x * scale, y: -point.y * scale }) }, state.layers, (name) => state.blocks[name]);
  return output.map((path) => path.map((point) => ({ x: point.x / scale, y: -point.y / scale })));
}

/** Canvas's screen multiply/divide can round the last double bit; topology stays exact. */
function expectCanvasPaths(actual: readonly (readonly Point[])[], expected: readonly (readonly Point[])[], scale = view.scale): void {
  expect(actual.map((path) => path.length)).toEqual(expected.map((path) => path.length));
  actual.forEach((path, pathIndex) => path.forEach((point, index) => {
    const reference = expected[pathIndex]![index]!;
    expect(Math.abs(point.x - reference.x) * scale).toBeLessThanOrEqual(1e-10);
    expect(Math.abs(point.y - reference.y) * scale).toBeLessThanOrEqual(1e-10);
  }));
}

/** Record actual Canvas strokes, preserving save/restore and per-child paint settings. */
function canvasScenePaints(state: DrawingState, camera: Gpu2DView, ov: Gpu2DOverlay) {
  const output: Array<{ paths: Point[][]; color: string; alpha: number; widthCss: number }> = [];
  let current: Point[][] = [];
  const stack: Array<{ globalAlpha: number; lineWidth: number; strokeStyle: string; fillStyle: string }> = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter',
    save() { stack.push({ globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, strokeStyle: this.strokeStyle, fillStyle: this.fillStyle }); },
    restore() { Object.assign(this, stack.pop()!); },
    setLineDash() {},
    beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push([{ x: x / camera.scale, y: -y / camera.scale }]); },
    lineTo(x: number, y: number) { current[current.length - 1]!.push({ x: x / camera.scale, y: -y / camera.scale }); },
    stroke() { output.push({ paths: current, color: this.strokeStyle, alpha: this.globalAlpha, widthCss: this.lineWidth }); },
  };
  const hidden = new Set(state.layers.filter((entry) => !entry.visible).map((entry) => entry.name));
  const previousWeights = { ...lineweightDisplay };
  lineweightDisplay.enabled = camera.lineweights ?? false;
  lineweightDisplay.pxPerMm = undefined;
  try {
    for (const entity of state.entities) {
      if (hidden.has(entity.layer)) continue;
      const selected = ov.selection.has(entity.id), hovered = ov.hover === entity.id && !selected;
      const style = selected ? { lineWidthOverride: 2.5, alpha: 0.95, hidden } : hovered ? { lineWidthOverride: 2, alpha: 0.95, hidden } : { hidden };
      drawEntity(context as unknown as CanvasRenderingContext2D, entity, { scale: camera.scale, toScreen: (point) => ({ x: (point.x - camera.center.x) * camera.scale, y: -(point.y - camera.center.y) * camera.scale }) }, state.layers, (name) => state.blocks[name], style);
    }
  } finally { Object.assign(lineweightDisplay, previousWeights); }
  return output;
}

const oldStyles = textStyleRegistry.styles;
afterEach(() => { setTextStyles(oldStyles); colorDisplay.paper = false; lineweightDisplay.enabled = false; lineweightDisplay.pxPerMm = undefined; });

describe('all-or-nothing GPU stroke-scene lowering', () => {
  it.each(Array.from({ length: 15 }, (_, index) => index < 6 ? [index, 0] : [index % 3, Math.floor((index - 6) / 3) + 1]))('matches Canvas native justification %i/%i and never changes source anchors', (horizontal, vertical) => {
    const entity = text({ justification: { horizontal: horizontal as 0 | 1 | 2 | 3 | 4 | 5, vertical: vertical as 0 | 1 | 2 | 3 }, position: { x: 0, y: -5 }, alignmentPoint: { x: 0, y: 0 }, firstAlignmentPoint: { x: 999, y: 999 }, rotation: 0.3 });
    const state = sealImmutableData(drawing([entity]));
    const before = JSON.stringify(state);
    const result = accepted(lowerStrokeScene(state, view, overlay));
    expect(result.operations).toHaveLength(1);
    expectCanvasPaths(strokePoints(result), canvasTextPaths(entity));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('matches Canvas width, oblique, rotation, unknown glyph and decoration-control behavior in one paint operation', () => {
    const entity = text({ text: 'A%%uB%%oC%%k %%d %%p 雪', position: { x: 3, y: -4 }, widthFactor: 1.8, oblique: 0.35, rotation: 0.72, align: 'right' });
    const result = accepted(lowerStrokeScene(drawing([entity]), view, overlay));
    expectCanvasPaths(strokePoints(result), canvasTextPaths(entity));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.paths.length).toBeGreaterThan(10);
  });

  it('rebases every native text anchor before FIT/ALIGNED placement and glyph offsets at trillion coordinates', () => {
    for (const horizontal of [3, 5] as const) {
      const near = text({ height: 1 / 8192, position: { x: 1 / 8192, y: -2 / 8192 }, alignmentPoint: { x: 9 / 8192, y: 5 / 8192 }, firstAlignmentPoint: { x: -3 / 8192, y: 4 / 8192 }, justification: { horizontal, vertical: 0 }, widthFactor: 1.2, oblique: 0.22 });
      const center = { x: 1e12, y: -1e12 };
      const moved = { ...near, position: { x: center.x + near.position.x, y: center.y + near.position.y }, alignmentPoint: { x: center.x + near.alignmentPoint!.x, y: center.y + near.alignmentPoint!.y }, firstAlignmentPoint: { x: center.x + near.firstAlignmentPoint!.x, y: center.y + near.firstAlignmentPoint!.y } };
      const localView = { ...view, scale: 65536 };
      expect(strokePoints(lowerStrokeScene(drawing([moved]), { ...localView, center }, overlay))).toEqual(strokePoints(lowerStrokeScene(drawing([near]), localView, overlay)));
    }
  });

  it('constrains zoom reuse at the exact Canvas QTEXT boundary on both sides', () => {
    const readable = accepted(lowerStrokeScene(drawing([text({ height: 0.25 })]), view, overlay));
    expect(readable.minRatio).toBe(1);
    expect(readable.maxRatio).toBe(1.25);
    const small = text({ text: '%%uABC%%k', height: 0.249, align: 'center', rotation: 0.7, widthFactor: 1.3 });
    const placeholder = accepted(lowerStrokeScene(drawing([small]), view, overlay));
    expect(placeholder.maxRatio * small.height * view.scale).toBeLessThan(2.5);
    expect(placeholder.maxRatio).toBeGreaterThan(1);
    expect(placeholder.operations[0]!.paths).toHaveLength(1);
    expectCanvasPaths(strokePoints(placeholder), canvasTextPaths(small));
  });

  it('intersects all text thresholds and reads the drawing style rather than a stale global registry', () => {
    setTextStyles({ Standard: { ...STANDARD_TEXT_STYLE, font: 'arial.ttf' } });
    const current = drawing([text({ height: 0.26 }), text({ id: 'small', height: 0.24 })]);
    const result = accepted(lowerStrokeScene(current, view, overlay));
    expect(result.minRatio).toBeCloseTo(2.5 / 2.6);
    expect(result.maxRatio).toBeLessThan(2.5 / 2.4);
    expect(result.textStylesDependency).toBeUndefined();
    const styles = { Standard: { ...STANDARD_TEXT_STYLE, font: 'arial.ttf' } };
    const refused = lowerStrokeScene({ ...current, meta: { textStyles: styles } }, view, overlay);
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining('Canvas font') });
    const strokeStyles = { Standard: { ...STANDARD_TEXT_STYLE, font: 'romans.shx', widthFactor: 4, oblique: 70 } };
    const strokeState = { ...current, meta: { textStyles: strokeStyles } };
    const strokeResult = accepted(lowerStrokeScene(strokeState, view, overlay));
    expect(strokeResult.textStylesDependency).toBe(strokeStyles);
    // The existing SHX Canvas branch uses entity width/shear, not STYLE width/shear.
    expect(strokePoints(strokeResult)).toEqual(strokePoints(result));
  });

  it('preserves top-level and nested child order, block colors, root lineweight and owner selection', () => {
    const nested: BlockDef = { name: 'NESTED', basePoint: { x: 1, y: 2 }, entities: [line('nested-line'), text({ id: 'nested-text', color: 0 })], attributes: [] };
    const block: BlockDef = {
      name: 'BLOCK', basePoint: { x: 4, y: 5 },
      entities: [{ ...line('first-child'), color: 0, lineWeight: 10 }, insert('NESTED', { id: 'nested', position: { x: 6, y: 8 }, scale: 1, rotation: 0.2, color: 0 }), { ...line('hidden-child'), layer: 'HIDDEN' }, text({ id: 'last-child', color: 1, trueColor: 0x123456 })],
      attributes: [{ tag: 'TAG1', prompt: 'Tag', default: 'DEFAULT', position: { x: 4, y: 5 }, height: 1, align: 'left' }, { tag: 'TAG2', prompt: '', default: 'HIDDEN', invisible: true, position: { x: 0, y: 0 }, height: 1, align: 'left' }, { tag: 'DESC', prompt: '', default: 'HIDDEN', position: { x: 0, y: 0 }, height: 1, align: 'left' }],
    };
    const owner = insert('BLOCK', { id: 'owner', color: 2, trueColor: 0xabcdef, lineWeight: 1, attributes: { TAG1: 'LIVE' }, hiddenAttributes: ['DESC'] });
    const state = sealImmutableData(drawing([line('before'), owner, line('after')], { BLOCK: block, NESTED: nested }, [layer, { ...layer, name: 'HIDDEN', visible: false }, { ...layer, name: 'TAGS' }]));
    const result = accepted(lowerStrokeScene(state, { ...view, lineweights: true }, overlay));
    expect(result.operations.map((operation) => operation.sourceId)).toEqual(['before', 'first-child', 'nested-line', 'nested-text', 'last-child', 'owner:TAG1', 'after']);
    expect(result.operations.map((operation) => operation.ownerId)).toEqual(['before', 'owner', 'owner', 'owner', 'owner', 'owner', 'after']);
    expect(result.operations.slice(1, -1).every((operation) => operation.widthCss === 4)).toBe(true);
    expect(result.operations[1]!.color).toEqual([0xab / 255, 0xcd / 255, 0xef / 255]);
    expect(result.operations[4]!.color).toEqual([0x12 / 255, 0x34 / 255, 0x56 / 255]);
    expect(result.blockDependencies.get('BLOCK')).toBe(state.blocks.BLOCK);
    expect(result.blockDependencies.get('NESTED')).toBe(state.blocks.NESTED);
    expect(new Set(result.operations.map((operation) => operation.paintId)).size).toBe(result.operations.length);
    const selected = accepted(lowerStrokeScene(state, view, { selection: new Set(['owner']), solidSelection: true }));
    expect(selected.operations.slice(1, -1).every((operation) => operation.widthCss === 2.5 && operation.alpha === 0.95)).toBe(true);
    const hovered = accepted(lowerStrokeScene(state, view, { selection: new Set(), hover: 'owner' }));
    expect(hovered.operations.slice(1, -1).every((operation) => operation.widthCss === 2 && operation.alpha === 0.95)).toBe(true);
  });

  it('keeps tiny block geometry and per-insert attribute anchors after trillion-coordinate rebasing', () => {
    const unit = 1 / 8192;
    const block: BlockDef = { name: 'SMALL', basePoint: { x: 5 * unit, y: 7 * unit }, entities: [{ ...line(), a: { x: 6 * unit, y: 7 * unit }, b: { x: 9 * unit, y: 8 * unit } }], attributes: [{ tag: 'LABEL', prompt: '', default: 'A', position: { x: 5 * unit, y: 7 * unit }, height: unit, align: 'left' }] };
    const near = insert('SMALL', { position: { x: 3 * unit, y: -4 * unit }, scale: 1, rotation: 0.3, attributePlacements: { LABEL: { position: { x: 8 * unit, y: 9 * unit }, alignmentPoint: { x: 11 * unit, y: 14 * unit }, firstAlignmentPoint: { x: 8 * unit, y: 9 * unit }, justification: { horizontal: 5, vertical: 0 }, height: unit, align: 'left' } } });
    const center = { x: 1e12, y: -1e12 }, localView = { ...view, scale: 65536 };
    const far = { ...near, position: { x: center.x + near.position.x, y: center.y + near.position.y } };
    expect(accepted(lowerStrokeScene(drawing([far], { SMALL: block }), { ...localView, center }, overlay)).operations).toEqual(accepted(lowerStrokeScene(drawing([near], { SMALL: block }), localView, overlay)).operations);
  });

  it('does not prune visible explicit-layer descendants of a nested insert whose own layer is hidden', () => {
    const leaf: BlockDef = { name: 'LEAF', basePoint: { x: 0, y: 0 }, entities: [{ ...line('visible'), layer: 'VISIBLE' }, line('inherits-hidden')], attributes: [] };
    const root: BlockDef = { name: 'ROOT', basePoint: { x: 0, y: 0 }, entities: [insert('LEAF', { layer: 'HIDDEN' })], attributes: [] };
    const result = accepted(lowerStrokeScene(drawing([insert('ROOT')], { ROOT: root, LEAF: leaf }, [layer, { ...layer, name: 'HIDDEN', visible: false }, { ...layer, name: 'VISIBLE' }]), view, overlay));
    expect(result.operations.map((operation) => operation.sourceId)).toEqual(['visible']);
  });

  it('matches actual Canvas paint order, attributes, lineweights, child opacity and owner highlight', () => {
    const nested: BlockDef = { name: 'N', basePoint: { x: 1, y: 2 }, entities: [text({ id: 'nested-text', color: 0, align: 'center' }), { ...line('nested-line'), layer: 'EXPLICIT', color: 1, transparency: 255 }], attributes: [] };
    const block: BlockDef = {
      name: 'B', basePoint: { x: 2, y: 3 },
      entities: [{ ...line('first'), color: 0, lineWeight: 10, transparency: 255 }, insert('N', { id: 'nested', position: { x: 5, y: 6 }, scale: 1, rotation: 0.3, color: 0 }), { ...text({ id: 'hidden', bold: true }), layer: 'HIDDEN' }],
      attributes: [{ tag: 'TAG', prompt: '', default: 'ATTR', position: { x: 2, y: 3 }, height: 1, align: 'right', widthFactor: 1.3, color: 0 }],
    };
    const owner = insert('B', { id: 'owner', lineWeight: 1, transparency: 128, color: 2, trueColor: 0xabcdef });
    const state = drawing([line('before'), owner, line('after')], { B: block, N: nested }, [layer, { ...layer, name: 'EXPLICIT', color: 4 }, { ...layer, name: 'HIDDEN', visible: false }, { ...layer, name: 'TAGS' }]);
    // Make inherited text/attribute opacity explicit and opaque while retaining the transparent root.
    const opaqueBlock = { ...block, attributes: block.attributes.map((attribute) => ({ ...attribute, transparency: 255 })) };
    const opaqueNested = { ...nested, entities: nested.entities.map((entity) => ({ ...entity, transparency: 255 })) };
    const current = { ...state, blocks: { B: opaqueBlock, N: opaqueNested } };
    const camera = { ...view, lineweights: true };
    for (const ov of [overlay, { selection: new Set(['owner']), solidSelection: true }, { selection: new Set<string>(), hover: 'owner' }]) {
      const actual = accepted(lowerStrokeScene(current, camera, ov));
      const expected = canvasScenePaints(current, camera, ov);
      expect(actual.operations).toHaveLength(expected.length);
      actual.operations.forEach((operation, index) => {
        const reference = expected[index]!;
        expect(operation.widthCss).toBe(reference.widthCss);
        expect(operation.alpha).toBe(reference.alpha);
        expect(operation.color.map((component) => Math.round(component * 255))).toEqual([1, 3, 5].map((offset) => Number.parseInt(reference.color.slice(offset, offset + 2), 16)));
        const points = operation.paths.map((path) => {
          if (path.kind === 'path') return path.points;
          if (path.entity.type !== 'line') throw new Error('Unexpected recorded primitive');
          return [path.entity.a, path.entity.b];
        });
        expectCanvasPaths(points, reference.paths, camera.scale);
      });
    }
  });

  it.each([
    ['missing', {}],
    ['xref', { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [], xref: { path: 'other.dwg' } } }],
    ['cyclic', { B: { name: 'B', basePoint: { x: 0, y: 0 }, entities: [insert('B')], attributes: [] } }],
  ] satisfies [string, Record<string, BlockDef>][])('refuses %s blocks without exposing partially compiled operations', (_name, blocks) => {
    const result = lowerStrokeScene(drawing([line('valid-first'), insert('B')], blocks), view, overlay);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('operations');
  });

  it.each([{ scaleY: 3 }, { mirror: true }, { rows: 2 }, { columns: 2 }, { scale: 0 }, { scale: Infinity }, { rotation: NaN }, { annotative: true }])('refuses unsafe nested block transform %j', (patch) => {
    const leaf: BlockDef = { name: 'LEAF', basePoint: { x: 0, y: 0 }, entities: [line()], attributes: [] };
    const root: BlockDef = { name: 'ROOT', basePoint: { x: 0, y: 0 }, entities: [line('valid-first'), insert('LEAF', patch)], attributes: [] };
    expect(lowerStrokeScene(drawing([insert('ROOT')], { ROOT: root, LEAF: leaf }), view, overlay).ok).toBe(false);
  });

  it('refuses deep and excessive expansion before allowing core to silently truncate it', () => {
    const blocks: Record<string, BlockDef> = {};
    for (let i = 0; i < 10; i++) blocks[`B${i}`] = { name: `B${i}`, basePoint: { x: 0, y: 0 }, entities: i < 9 ? [insert(`B${i + 1}`)] : [line()], attributes: [] };
    expect(lowerStrokeScene(drawing([insert('B0')], blocks), view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('depth budget') });
    expect(lowerStrokeScene(drawing([text()]), view, overlay, { maxPoints: 1 }).ok).toBe(false);
    expect(lowerStrokeScene(drawing([text()]), view, overlay, { maxWork: 1 }).ok).toBe(false);
    expect(lowerStrokeScene(drawing([line(), line('second')]), view, overlay, { maxEntities: 1 }).ok).toBe(false);
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [line(), line('second')], attributes: [] };
    expect(lowerStrokeScene(drawing([insert('B')], { B: block }), view, overlay, { maxEntities: 1 }).ok).toBe(false);
  });

  it('enforces the complete-scene point budget before allocating readable glyph strokes', () => {
    const readable = text({ text: 'WWWW %%c %%d %%p \u96ea' });
    const pointCount = strokePoints(lowerStrokeScene(drawing([readable]), view, overlay)).reduce((total, path) => total + path.length, 0);
    const glyphs = vi.spyOn(hershey, 'strokeText');
    try {
      const refused = lowerStrokeScene(drawing([line('before'), readable]), view, overlay, { maxPoints: pointCount + 1 });
      expect(refused).toEqual({ ok: false, reason: expect.stringContaining('point budget') });
      expect(refused).not.toHaveProperty('operations');
      expect(glyphs).not.toHaveBeenCalled();
      expect(lowerStrokeScene(drawing([line('before'), readable]), view, overlay, { maxPoints: pointCount + 2 }).ok).toBe(true);
      expect(glyphs).toHaveBeenCalledTimes(1);
      glyphs.mockClear();
      expect(lowerStrokeScene(drawing([text({ text: 'W'.repeat(100_000) })]), view, overlay, { maxPoints: 10 })).toEqual({ ok: false, reason: expect.stringContaining('point budget') });
      expect(glyphs).not.toHaveBeenCalled();
      const qtext = accepted(lowerStrokeScene(drawing([text({ text: 'W'.repeat(100_000), height: 0.01 })]), view, overlay, { maxPoints: 2 }));
      expect(qtext.operations[0]!.paths).toHaveLength(1);
      expect(strokePoints(qtext)[0]).toHaveLength(2);
      expect(glyphs).not.toHaveBeenCalled();
    } finally { glyphs.mockRestore(); }
  });

  it('refuses unsupported late child text and transparency but skips invisible unsupported primitives', () => {
    const bad = text({ id: 'late', bold: true });
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [line(), bad], attributes: [] };
    expect(lowerStrokeScene(drawing([line('before'), insert('B')], { B: block }), view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('bold') });
    const hiddenBlock = { ...block, entities: [line(), { ...bad, layer: 'HIDDEN' }] };
    expect(lowerStrokeScene(drawing([insert('B')], { B: hiddenBlock }, [layer, { ...layer, name: 'HIDDEN', visible: false }]), view, overlay).ok).toBe(true);
    const alphaBlock = { ...block, entities: [{ ...line(), transparency: 'ByBlock' as const }] };
    expect(lowerStrokeScene(drawing([insert('B', { transparency: 128 })], { B: alphaBlock }), view, overlay).ok).toBe(false);
    // Canvas resets each child's alpha from its inherited source; it does not multiply parent alpha.
    expect(lowerStrokeScene(drawing([insert('B', { transparency: 128 })], { B: { ...block, entities: [{ ...line(), transparency: 255 }] } }), view, overlay).ok).toBe(true);
  });

  it('invalidates dependencies on nested redefinition/undo and does not leak global drawing styles on refusal', () => {
    const nested: BlockDef = { name: 'N', basePoint: { x: 0, y: 0 }, entities: [line()], attributes: [] };
    const root: BlockDef = { name: 'R', basePoint: { x: 0, y: 0 }, entities: [insert('N')], attributes: [] };
    const state = drawing([insert('R')], { R: root, N: nested });
    const first = accepted(lowerStrokeScene(state, view, overlay));
    const changed = { ...nested, entities: [line('changed')] };
    const second = accepted(lowerStrokeScene({ ...state, blocks: { R: root, N: changed } }, view, overlay));
    expect(second.blockDependencies.get('N')).toBe(changed);
    expect(first.blockDependencies.get('N')).toBe(nested);
    expect(accepted(lowerStrokeScene(state, view, overlay)).blockDependencies.get('N')).toBe(nested);
    colorDisplay.paper = true;
    lineweightDisplay.enabled = true;
    lineweightDisplay.pxPerMm = 17;
    expect(lowerStrokeScene(drawing([text({ bold: true })]), view, overlay).ok).toBe(false);
    expect(colorDisplay.paper).toBe(true);
    expect(lineweightDisplay).toEqual({ enabled: true, pxPerMm: 17 });
  });

  it('keeps unsupported dimensions/MTEXT/hatches on full-view fallback and refuses dashed selection', () => {
    const mtext: Entity = { id: 'm', type: 'mtext', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'Formatted', height: 1, width: 10, rotation: 0, attachment: 1, lineSpacing: 1 };
    expect(lowerStrokeScene(drawing([line(), mtext]), view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('Unsupported entity: mtext') });
    expect(lowerStrokeScene(drawing([text()]), view, { selection: new Set(['text']) }).ok).toBe(false);
    expect(lowerStrokeScene(drawing([{ ...line(), transparency: 128 }]), view, overlay).ok).toBe(false);
    expect(lowerStrokeScene(drawing([text({ height: NaN })]), view, overlay).ok).toBe(false);
    expect(lowerStrokeScene(drawing([text({ position: { x: Infinity, y: 0 } })]), view, overlay).ok).toBe(false);
    const dashed = { ...drawing([line()]), header: { ...DEFAULT_HEADER, linetypes: [{ name: 'CUSTOM', description: '', pattern: [1, -1] }] } };
    expect(lowerStrokeScene({ ...dashed, entities: [{ ...line(), linetype: 'CUSTOM' }] }, view, overlay).ok).toBe(false);
  });
});
