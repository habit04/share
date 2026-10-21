import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { DEFAULT_HEADER } from '../src/core/document';
import type { BlockDef, Entity, HatchEntity, InsertEntity, Layer, LineEntity, TextEntity } from '../src/core/entities';
import type { Point } from '../src/core/geometry';
import * as coreEntities from '../src/core/entities';
import { entityGeometryWork, hatchGeometry } from '../src/core/entities';
import { lowerHatchStrokes } from '../src/render/gpu-prototype/hatch-strokes';
import * as hatchLowering from '../src/render/gpu-prototype/hatch-strokes';
import { readDxf, writeDxf } from '../src/io/dxf';
import { isSourcePrecisionCertificateError, isSourceTopologyAdmissionError, sourcePrecisionCertificateError } from '../src/render/gpu-prototype/stroke-precision-error';
import { sealImmutableData } from '../src/core/immutable-data';
import { STANDARD_TEXT_STYLE } from '../src/io/encoding';
import { annotationDisplay, colorDisplay, drawEntity, lineweightDisplay } from '../src/render/draw';
import { setTextStyles, textStyleRegistry } from '../src/render/hershey';
import * as hershey from '../src/render/hershey';
import type { Gpu2DOverlay, Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { lowerStrokeScene, type LocalStrokePath, type LoweredStrokeScene, type StrokePaintOperation } from '../src/render/gpu-prototype/stroke-scene';

const layer: Layer = { name: '0', color: 3, visible: true, locked: false, lineWeight: 0.5 };
const view: Gpu2DView = { width: 320, height: 240, dpr: 1, scale: 10, center: { x: 0, y: 0 }, twist: 0, background: '#212830', lineweights: false };
const overlay = { selection: new Set<string>() };
const line = (id = 'line'): LineEntity => ({ id, type: 'line', layer: '0', color: 'ByLayer', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } });
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'text', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'Ag %%c', height: 1, rotation: 0, align: 'left', ...patch });
const insert = (block: string, patch: Partial<InsertEntity> = {}): InsertEntity => ({ id: 'insert', type: 'insert', layer: '0', color: 'ByLayer', block, position: { x: 7, y: 11 }, scale: 2, rotation: 0, attributes: {}, ...patch });
const drawing = (entities: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}, layers: readonly Layer[] = [layer]): DrawingState => ({ entities, blocks, layers, currentLayer: '0' });
type StrokeOnlyScene = Omit<Extract<LoweredStrokeScene, { ok: true }>, 'operations'> & {
  readonly operations: readonly Extract<StrokePaintOperation, { kind: 'stroke' }>[];
};
const accepted = (result: LoweredStrokeScene): StrokeOnlyScene => {
  if (!result.ok) throw new Error(result.reason);
  for (const operation of result.operations) {
    expect(operation.kind).toBe('stroke');
    if (operation.kind !== 'stroke') throw new Error('Existing fixture requires a stroke operation');
  }
  // Preserve the exact result/operation identities after validating every discriminator.
  return result as StrokeOnlyScene;
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
  const output: Array<{ paths: Point[][]; color: string; alpha: number; widthCss: number; dash: number[] }> = [];
  let current: Point[][] = [];
  const stack: Array<{ globalAlpha: number; lineWidth: number; strokeStyle: string; fillStyle: string; dash: number[] }> = [];
  const context = {
    globalAlpha: 1, lineWidth: 1, strokeStyle: '', fillStyle: '', lineCap: 'butt', lineJoin: 'miter', dash: [] as number[],
    save() { stack.push({ globalAlpha: this.globalAlpha, lineWidth: this.lineWidth, strokeStyle: this.strokeStyle, fillStyle: this.fillStyle, dash: [...this.dash] }); },
    restore() { Object.assign(this, stack.pop()!); },
    setLineDash(value: number[]) { this.dash = [...value]; },
    beginPath() { current = []; },
    moveTo(x: number, y: number) { current.push([{ x: x / camera.scale, y: -y / camera.scale }]); },
    lineTo(x: number, y: number) { current[current.length - 1]!.push({ x: x / camera.scale, y: -y / camera.scale }); },
    stroke() { output.push({ paths: current, color: this.strokeStyle, alpha: this.globalAlpha, widthCss: this.lineWidth, dash: [...this.dash] }); },
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
const oldAnnotation = { ...annotationDisplay };
afterEach(() => { setTextStyles(oldStyles); Object.assign(annotationDisplay, oldAnnotation); colorDisplay.paper = false; lineweightDisplay.enabled = false; lineweightDisplay.pxPerMm = undefined; });

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

  it('matches Canvas width, oblique, rotation and decoration-control behavior in one paint operation', () => {
    const entity = text({ text: 'A%%uB%%oC%%k %%d %%p ?', position: { x: 3, y: -4 }, widthFactor: 1.8, oblique: 0.35, rotation: 0.72, align: 'right' });
    const result = accepted(lowerStrokeScene(drawing([entity]), view, overlay));
    expectCanvasPaths(strokePoints(result), canvasTextPaths(entity));
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]!.paths.length).toBeGreaterThan(10);
  });

  it('requires complete Canvas fallback for a Unicode glyph absent from the stroke font', () => {
    expect(lowerStrokeScene(drawing([text({ text: 'A雪' })]), view, overlay)).toEqual({ ok: false, reason: expect.stringContaining('Canvas font') });
  });

  it('keeps the independent near-origin FIT/ALIGNED proof and refuses unsafe Canvas world quantization', () => {
    for (const horizontal of [3, 5] as const) {
      const near = text({ height: 1 / 8192, position: { x: 1 / 8192, y: -2 / 8192 }, alignmentPoint: { x: 9 / 8192, y: 5 / 8192 }, firstAlignmentPoint: { x: -3 / 8192, y: 4 / 8192 }, justification: { horizontal, vertical: 0 }, widthFactor: 1.2, oblique: 0.22 });
      const center = { x: 1e12, y: -1e12 };
      const moved = { ...near, position: { x: center.x + near.position.x, y: center.y + near.position.y }, alignmentPoint: { x: center.x + near.alignmentPoint!.x, y: center.y + near.alignmentPoint!.y }, firstAlignmentPoint: { x: center.x + near.firstAlignmentPoint!.x, y: center.y + near.firstAlignmentPoint!.y } };
      const localView = { ...view, scale: 65536 };
      const reference = lowerStrokeScene(drawing([near]), localView, overlay);
      expectCanvasPaths(strokePoints(reference), canvasTextPaths(near, drawing([near]), localView.scale), localView.scale);
      expect(lowerStrokeScene(drawing([moved]), { ...localView, center }, overlay)).toEqual({ ok: false, reason: expect.stringContaining('world-coordinate quantization') });
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
    expect(accepted(lowerStrokeScene(drawing([near], { SMALL: block }), localView, overlay)).operations.length).toBeGreaterThan(0);
    expect(lowerStrokeScene(drawing([far], { SMALL: block }), { ...localView, center }, overlay)).toEqual({ ok: false, reason: expect.stringContaining('world-coordinate quantization') });
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

  it.each([false, true])('refuses the complete scene when the outer Canvas annotation wrapper scales or hides a root INSERT: %s', (hide) => {
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [line('child')], attributes: [] };
    const owner = insert('B', { id: 'annotative-owner', annotative: true });
    const state = sealImmutableData(drawing([line('valid-first'), owner], { B: block }));
    Object.assign(annotationDisplay, { factor: 2, hide });
    const painted = canvasScenePaints(state, view, overlay);
    if (hide) expect(painted).toHaveLength(1);
    else {
      expect(painted).toHaveLength(2);
      expect(painted[1]!.paths).toEqual([[{ x: -1, y: 11 }, { x: 15, y: 11 }]]);
    }
    const refused = lowerStrokeScene(state, view, overlay);
    expect(refused).toEqual({ ok: false, reason: 'Unsupported annotative block (annotative-owner)' });
    expect(refused).not.toHaveProperty('operations');
    expect(annotationDisplay).toEqual({ factor: 2, hide });
  });

  it('refuses a nested annotative INSERT before exposing earlier ordered strokes', () => {
    const leaf: BlockDef = { name: 'LEAF', basePoint: { x: 0, y: 0 }, entities: [line('leaf')], attributes: [] };
    const root: BlockDef = { name: 'ROOT', basePoint: { x: 0, y: 0 }, entities: [line('first-child'), insert('LEAF', { id: 'nested-annotation', annotative: true })], attributes: [] };
    const refused = lowerStrokeScene(drawing([line('valid-first'), insert('ROOT')], { ROOT: root, LEAF: leaf }), view, overlay);
    expect(refused).toEqual({ ok: false, reason: 'Unsupported annotative block (nested-annotation)' });
    expect(refused).not.toHaveProperty('operations');
  });

  it('matches child dash inheritance rather than multiplying a root INSERT dash across explicit continuous children', () => {
    const continuous: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [{ ...line('child'), linetype: 'Continuous' }], attributes: [] };
    const state = drawing([insert('B', { linetype: 'DASHED' })], { B: continuous });
    const painted = canvasScenePaints(state, view, overlay);
    expect(painted).toHaveLength(1);
    expect(painted[0]!.dash).toEqual([]);
    const acceptedScene = accepted(lowerStrokeScene(state, view, overlay));
    const path = acceptedScene.operations[0]!.paths[0]!;
    if (path.kind !== 'entity' || path.entity.type !== 'line') throw new Error('Expected continuous block line');
    expectCanvasPaths([[path.entity.a, path.entity.b]], painted[0]!.paths);
    const inherited: BlockDef = { ...continuous, entities: [{ ...line('child'), linetype: 'ByBlock' }] };
    const refused = lowerStrokeScene({ ...state, blocks: { B: inherited } }, view, overlay);
    expect(refused).toEqual({ ok: false, reason: expect.stringContaining('Unsupported dashed linetype: DASHED') });
    expect(refused).not.toHaveProperty('operations');
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
    const readable = text({ text: 'WWWW %%c %%d %%p ?' });
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


describe('ordered top-level hatch scene lowering', () => {
  afterEach(() => vi.restoreAllMocks());
  const square = (size: number, x = 0, y = 0) => ({ points: [{ x, y }, { x: x + size, y }, { x: x + size, y: y + size }, { x, y: y + size }] });
  const hatch = (patch: Partial<HatchEntity> = {}): HatchEntity => sealImmutableData({ id: 'hatch', type: 'hatch', layer: '0', color: 'ByLayer', solid: false, pattern: 'LINE', scale: 8, angle: 0, loops: [square(8)], origin: { x: 0.25, y: 0.25 }, ...patch });

  it.each(['LINE', 'NET', 'ANSI31', 'ANSI37'])('matches actual Canvas order, color, width and grouping for %s with overlapping neighbors', (pattern) => {
    const source = hatch({ pattern, lineWeight: 1, trueColor: 0xabc123, loops: [square(8), square(2, 3, 3)] });
    const state = sealImmutableData(drawing([line('before'), source, { ...line('after'), color: 1, lineWeight: 2 }]));
    const camera = { ...view, scale: 100, center: { x: 4, y: 4 }, lineweights: true };
    const lowered = accepted(lowerStrokeScene(state, camera, overlay));
    const canvas = canvasScenePaints(state, camera, overlay);
    expect(lowered.operations.map((operation) => operation.ownerId)).toEqual(['before', 'hatch', 'after']);
    expect(lowered.operations.map((operation) => operation.paintId)).toEqual(['before:0', 'hatch:1', 'after:2']);
    expect(lowered.operations).toHaveLength(canvas.length);
    lowered.operations.forEach((operation, index) => {
      const reference = canvas[index]!;
      expect(operation.widthCss).toBe(reference.widthCss); expect(operation.alpha).toBe(reference.alpha);
      expect(operation.color.map((channel) => Math.round(channel * 255))).toEqual([1, 3, 5].map((offset) => Number.parseInt(reference.color.slice(offset, offset + 2), 16)));
      expectCanvasPaths(operation.paths.map((path) => path.kind === 'path' ? path.points : path.entity.type === 'line' ? [path.entity.a, path.entity.b] : []), reference.paths, camera.scale);
    });
    expect(lowered.operations[1]!.sourcePoints).toEqual(source.loops.flatMap((loop) => loop.points.map((point) => ({ x: point.x - camera.center.x, y: point.y - camera.center.y }))));
  });

  it('uses complete original file families and concave/island geometry without changing source phase', () => {
    const source = hatch({ pattern: 'ANSI31', origin: { x: 999, y: 999 }, angle: 1.3, scale: 0.000001, double: true, loops: [{ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 8 }, { x: 0, y: 8 }] }, square(1, 0.5, 3)], patternLines: [
      { angle: 0, base: { x: 0.25, y: 0.25 }, offset: { x: 0.3, y: 1 }, dashes: [0.8, -0.4] },
      { angle: Math.PI / 2, base: { x: 0.25, y: 0.25 }, offset: { x: -1, y: 0 }, dashes: [] },
    ] });
    const state = sealImmutableData(drawing([source])), before = JSON.stringify(state);
    const camera = { ...view, scale: 10_000, center: { x: 4, y: 4 } };
    const lowered = accepted(lowerStrokeScene(state, camera, overlay));
    expect(lowered.operations[0]!.paths.map((path) => path.kind === 'path' ? path.points : [])).toEqual(hatchGeometry(source).segments.map((segment) => segment.map((point) => ({ x: point.x - 4, y: point.y - 4 }))));
    expect(JSON.stringify(state)).toBe(before);
  });

  it('shares hatch preparation work across the scene and refuses the second hatch before its generator runs', () => {
    const source = hatch();
    const one = lowerHatchStrokes(source, view);
    if (!one.ok) throw new Error(one.reason);
    const allowance = entityGeometryWork(source) + one.preparationWork;
    const generator = vi.spyOn(coreEntities, 'hatchGeometry');
    const scene = drawing([sealImmutableData(structuredClone(source)), sealImmutableData({ ...source, id: 'second' })]);
    expect(lowerStrokeScene(scene, view, overlay, { maxWork: allowance * 2 - 1 })).toMatchObject({ ok: false, reason: expect.stringContaining('preparation-work budget') });
    expect(generator).toHaveBeenCalledTimes(2); // Original Canvas cache and fresh canonical certificate.
    expect(lowerStrokeScene(scene, view, overlay, { maxWork: allowance * 2 }).ok).toBe(true);
    generator.mockClear();
    expect(lowerStrokeScene(scene, view, overlay, { maxPoints: 3 })).toMatchObject({ ok: false, reason: expect.stringContaining('point budget') });
    expect(generator).not.toHaveBeenCalled();
  });

  it('shares retained boundary, local and copied WORLD points across neighboring hatches before allocation', () => {
    const triangle = { loops: [{ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 0, y: 8 }] }], patternLines: [
      { angle: 0, base: { x: 0, y: 0.5 }, offset: { x: 0, y: 4 }, dashes: [] },
    ] };
    const first = hatch({ ...triangle, id: 'first' }), second = hatch({ ...triangle, id: 'second' });
    const state = drawing([line('neighbor'), first, second]);
    const original = JSON.stringify(state);
    const generator = vi.spyOn(coreEntities, 'hatchGeometry');
    const refused = lowerStrokeScene(state, view, overlay, { maxPoints: 23 });
    expect(refused).toMatchObject({ ok: false, reason: expect.stringContaining('segment budget') });
    expect(refused).not.toHaveProperty('operations');
    expect(generator).toHaveBeenCalledTimes(2);
    expect(generator.mock.calls.every(([entity]) => entity.id === 'first')).toBe(true);
    const admitted = accepted(lowerStrokeScene(state, view, overlay, { maxPoints: 24 }));
    expect(admitted.operations.map((operation) => operation.ownerId)).toEqual(['neighbor', 'first', 'second']);
    const retained = admitted.operations.slice(1).flatMap((operation) => [
      ...operation.sourcePoints!, ...operation.paths.flatMap((path) => {
        if (path.kind !== 'path' || !path.worldPoints) throw new Error('Expected original hatch provenance');
        return [...path.points, ...path.worldPoints];
      }),
    ]);
    expect(retained).toHaveLength(22);
    expect(new Set(retained).size).toBe(retained.length);
    expect(JSON.stringify(state)).toBe(original);
  });

  it('retains copied exact original-world endpoint provenance while rebasing boundaries only', () => {
    const source = hatch({ origin: { x: 0.13, y: 0.27 }, angle: 0.17 });
    const state = drawing([source]); const original = JSON.stringify(state);
    const camera = { ...view, scale: 100, center: { x: 2.3, y: 3.7 }, dpr: 2 };
    const result = accepted(lowerStrokeScene(state, camera, overlay));
    const canonical = hatchGeometry(source);
    expect(result.operations).toHaveLength(1);
    result.operations[0]!.paths.forEach((path, index) => {
      if (path.kind !== 'path' || !path.worldPoints) throw new Error('Expected canonical hatch path');
      path.worldPoints.forEach((point, endpoint) => {
        const originalPoint = canonical.segments[index]![endpoint]!;
        expect(Object.is(point.x, originalPoint.x)).toBe(true); expect(Object.is(point.y, originalPoint.y)).toBe(true);
        expect(point).not.toBe(originalPoint); expect(point).not.toBe(path.points[endpoint]);
        expect(path.points[endpoint]).toEqual({ x: originalPoint.x - camera.center.x, y: originalPoint.y - camera.center.y });
      });
    });
    expect(result.operations[0]!.sourcePoints).toHaveLength(source.loops[0]!.points.length);
    expectCanvasPaths(result.operations[0]!.paths.map((path) => path.kind === 'path' ? path.points : []), canvasScenePaints(state, camera, overlay)[0]!.paths, camera.scale);
    expect(JSON.stringify(state)).toBe(original);
  });

  it('passes resolved actual Canvas lineweight and retained pan interval into source certification', () => {
    const source = hatch({ lineWeight: 0.5 });
    const state = drawing([source]); const camera = { ...view, lineweights: true };
    const lowerer = vi.spyOn(hatchLowering, 'lowerHatchStrokes');
    const result = accepted(lowerStrokeScene(state, camera, overlay, { panPadding: 16 }));
    const canvas = canvasScenePaints(state, camera, overlay);
    expect(lowerer).toHaveBeenCalledOnce();
    expect(lowerer.mock.calls[0]![0]).toBe(source); expect(lowerer.mock.calls[0]![1]).toBe(camera);
    expect(lowerer.mock.calls[0]![2]).toMatchObject({ widthCss: canvas[0]!.widthCss, panPadding: 16 });
    expect(result.operations[0]!.widthCss).toBe(canvas[0]!.widthCss);
  });

  it.each([0.17, 0.23, 0.43, Math.PI / 4])('keeps the original painted twist %s as a complete-view Canvas control', (twist) => {
    const source = hatch(); const state = drawing([source, line('after')]);
    const original = JSON.stringify(state); const lowerer = vi.spyOn(hatchLowering, 'lowerHatchStrokes');
    const result = lowerStrokeScene(state, { ...view, twist }, overlay);
    expect(lowerer).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: false, reason: 'Unsupported Canvas stroke construction: native context rotation is unproved' });
    expect(result).not.toHaveProperty('operations');
    if (result.ok) throw new Error('Expected native context refusal');
    expect(isSourceTopologyAdmissionError(result.cause)).toBe(true);
    expect(isSourcePrecisionCertificateError(result.cause)).toBe(false);
    expect(JSON.stringify(state)).toBe(original);
  });

  it('retains a deliberate precision factory identity for the geometry builder interval retry', () => {
    const source = hatch(); const state = drawing([line('before'), source]);
    const cause = sourcePrecisionCertificateError('Canvas hatch projection exceeds precision bound');
    const lowerer = vi.spyOn(hatchLowering, 'lowerHatchStrokes').mockReturnValueOnce({ ok: false, reason: cause.message, cause });
    const result = lowerStrokeScene(state, view, overlay, { maxRatio: 4 });
    expect(lowerer).toHaveBeenCalledOnce(); expect(result).not.toHaveProperty('operations');
    if (result.ok) throw new Error('Expected deliberate precision refusal');
    expect(result.cause).toBe(cause); expect(isSourcePrecisionCertificateError(result.cause)).toBe(true);
    expect(isSourceTopologyAdmissionError(result.cause)).toBe(false);
    expect(lowerStrokeScene(state, view, overlay, { maxRatio: 1.25 }).ok).toBe(true);
  });

  it.each([new TypeError('Curved hatch boundary requires Canvas'), new RangeError('Canvas hatch projection exceeds precision bound'), { interrupted: true }])('retains an unknown generator failure and retries the same source: %s', (cause) => {
    const source = hatch(); const state = drawing([line('before'), source]); const original = JSON.stringify(state);
    const generator = vi.spyOn(coreEntities, 'hatchGeometry').mockImplementationOnce(() => { throw cause; });
    const result = lowerStrokeScene(state, view, overlay);
    expect(generator).toHaveBeenCalledOnce(); expect(result).not.toHaveProperty('operations');
    if (result.ok) throw new Error('Expected unknown generator failure');
    expect(result.cause).toBeInstanceOf(Error);
    expect((result.cause as Error).cause).toBe(cause);
    expect(isSourcePrecisionCertificateError(result.cause)).toBe(false); expect(isSourceTopologyAdmissionError(result.cause)).toBe(false);
    expect(isSourcePrecisionCertificateError(cause)).toBe(false); expect(isSourceTopologyAdmissionError(cause)).toBe(false);
    expect(lowerStrokeScene(state, view, overlay).ok).toBe(true);
    expect(JSON.stringify(state)).toBe(original);
  });

  it('compiles authored DXF islands and file families through edit, undo, redo and save/reopen', () => {
    const source = hatch({ loops: [square(8), square(2, 3, 3)], double: true, patternLines: [
      { angle: 0, base: { x: 0, y: 0.25 }, offset: { x: 0, y: 1 }, dashes: [] },
      { angle: Math.PI / 2, base: { x: 0.25, y: 0 }, offset: { x: -1, y: 0 }, dashes: [] },
    ] });
    const document = new Drawing(); document.addEntities([line('before'), source, line('after')]);
    const imported = new Drawing(readDxf(writeDxf(document.snapshot)));
    const before = imported.entities.find((entity): entity is HatchEntity => entity.type === 'hatch')!;
    const initial = accepted(lowerStrokeScene(imported.snapshot, view, overlay));
    const initialPaths = initial.operations[1]!.paths;
    expect(initial.operations).toHaveLength(3); expect(before.loops).toHaveLength(2); expect(before.patternLines).toHaveLength(2);
    expect(imported.dirty).toBe(false);
    imported.replaceEntities([{ ...before, patternLines: before.patternLines!.map((family) => ({ ...family, base: { x: family.base.x + 0.25, y: family.base.y + 0.25 } })) }]);
    const edited = accepted(lowerStrokeScene(imported.snapshot, view, overlay));
    expect(imported.dirty).toBe(true); expect(edited.operations[1]!.paths).not.toEqual(initialPaths);
    imported.undo(); expect(imported.entities[1]).toBe(before);
    expect(accepted(lowerStrokeScene(imported.snapshot, view, overlay)).operations[1]!.paths).toEqual(initialPaths);
    imported.redo();
    const reopened = new Drawing(readDxf(writeDxf(imported.snapshot)));
    const saved = reopened.entities.find((entity): entity is HatchEntity => entity.type === 'hatch')!;
    expect(saved.loops).toEqual(before.loops); expect(saved.patternLines).toHaveLength(2);
    const reopenedScene = accepted(lowerStrokeScene(reopened.snapshot, view, overlay));
    // DXF import assigns new internal entity IDs. Preserve every path property and
    // geometry while checking each operation belongs to its newly imported owner.
    const semanticPaths = (scene: typeof edited) => scene.operations.map((operation) => operation.paths.map((path) =>
      path.kind === 'entity' ? { ...path, entity: { ...path.entity, id: 'imported-owner' } } : path));
    expect(reopenedScene.operations.map((operation) => operation.ownerId)).toEqual(reopened.entities.map((entity) => entity.id));
    expect(semanticPaths(reopenedScene)).toEqual(semanticPaths(edited));
    expect(reopenedScene.operations.map((operation) => operation.sourcePoints)).toEqual(edited.operations.map((operation) => operation.sourcePoints));
    const canvas = canvasScenePaints(reopened.snapshot, view, overlay);
    expectCanvasPaths(reopenedScene.operations[1]!.paths.map((path) => path.kind === 'path' ? path.points : []), canvas[1]!.paths, view.scale);
    expect(saved.patternLines).toEqual((imported.entities[1] as HatchEntity).patternLines);
  });

  it('narrows the whole scene zoom interval above the Canvas dot decision', () => {
    const source = hatch({ loops: [{ points: [{ x: 0, y: 0 }, { x: 0.6, y: 0 }, { x: 0.6, y: 2 }, { x: 0, y: 2 }] }], scale: 1, origin: undefined });
    const result = accepted(lowerStrokeScene(drawing([line(), source]), { ...view, scale: 1, twist: 0, dpr: 2 }, overlay));
    expect(result.minRatio).toBeGreaterThan((0.5 + 0.0625 / 2) / 0.6); expect(result.minRatio).toBeLessThan(0.886);
    expect(lowerStrokeScene(drawing([line(), source]), { ...view, scale: 0.8, twist: 0, dpr: 2 }, overlay)).toMatchObject({ ok: false, reason: expect.stringContaining('short strokes') });
  });

  it('keeps late dots, solid/dense/curved patterns, highlights and inherited transparency on complete-view fallback', () => {
    for (const source of [hatch({ pattern: 'DOTS' }), hatch({ solid: true }), hatch({ scale: 0.000001 }), hatch({ loops: [{ ...square(8), bulges: [1] }] }), hatch({ transparency: 128 }), hatch({ patternLines: [{ angle: 0, base: { x: 0, y: 0 }, offset: { x: 0, y: 1 }, dashes: [0, -1] }] })]) {
      const result = lowerStrokeScene(drawing([line('valid-first'), source]), view, overlay);
      expect(result.ok).toBe(false); expect(result).not.toHaveProperty('operations');
    }
    for (const ov of [{ selection: new Set(['hatch']), solidSelection: true }, { selection: new Set<string>(), hover: 'hatch' }]) expect(lowerStrokeScene(drawing([hatch()]), view, ov).ok).toBe(false);
    expect(lowerStrokeScene(drawing([hatch()], {}, [{ ...layer, transparency: 128 }]), view, overlay).ok).toBe(false);
    const hidden = hatch({ layer: 'HIDDEN', solid: true });
    expect(accepted(lowerStrokeScene(drawing([line(), hidden], {}, [layer, { ...layer, name: 'HIDDEN', visible: false }]), view, { selection: new Set(['hatch']) })).operations.map((operation) => operation.ownerId)).toEqual(['line']);
  });

  it('refuses block hatches instead of generating a phase from an anchor-local transformed copy', () => {
    const definition: BlockDef = { name: 'H', basePoint: { x: 4, y: 3 }, entities: [line('valid-child'), hatch()], attributes: [] };
    const result = lowerStrokeScene(drawing([line('before'), insert('H')], { H: definition }), view, overlay);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('Hatches inside blocks') });
    expect(result).not.toHaveProperty('operations');
  });

  it('requires deep runtime hatch certification even when the outer object is frozen', () => {
    const mutable = structuredClone(hatch());
    const shallow = Object.freeze(mutable);
    expect(Object.isFrozen(shallow)).toBe(true);
    expect(Object.isFrozen(shallow.loops)).toBe(false);
    const generator = vi.spyOn(coreEntities, 'hatchGeometry');
    const result = lowerStrokeScene(drawing([line('before'), shallow]), view, overlay);
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('Mutable hatch') });
    expect(result).not.toHaveProperty('operations');
    expect(generator).not.toHaveBeenCalled();
    // A mutable outer view snapshot may still use a deeply certified source safely.
    const replacement = sealImmutableData(structuredClone(shallow));
    expect(lowerStrokeScene(drawing([replacement]), view, overlay).ok).toBe(true);
  });
});
