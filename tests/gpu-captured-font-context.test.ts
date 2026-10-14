import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import { STANDARD_DIMSTYLE, type DimensionEntity } from '../src/core/dimension';
import type { BlockDef, BlockLookup, Entity, HatchEntity, InsertEntity, TextEntity } from '../src/core/entities';
import { dimensionParts } from '../src/core/entities';
import * as entities from '../src/core/entities';
import { sealImmutableData } from '../src/core/immutable-data';
import type { TextAppearance, TextGeometryContext } from '../src/core/text-metrics';
import { STANDARD_TEXT_STYLE, textStylesOf } from '../src/io/encoding';
import { DrawingShxResources } from '../src/render/drawing-shx';
import { lowerDimensionStrokes } from '../src/render/gpu-prototype/dimension-strokes';
import { certifyDimensionNativeSource } from '../src/render/gpu-prototype/dimension-native-source';
import type { Gpu2DView } from '../src/render/gpu-prototype/geometry2d';
import { lowerHatchStrokes } from '../src/render/gpu-prototype/hatch-strokes';
import { lowerStrokeScene } from '../src/render/gpu-prototype/stroke-scene';
import { shxFixture } from './helpers/shx-fixture';

const view: Gpu2DView = { width: 800, height: 600, scale: 20, dpr: 1, center: { x: 0, y: 0 }, twist: 0, background: '#212830' };
const overlay = { selection: new Set<string>() };
const stroke: TextAppearance = { kind: 'stroke', widthFactor: 1, oblique: 0 };
const native: TextAppearance = { kind: 'canvas', family: 'Authored test face', bold: false, italic: false, widthFactor: 1, oblique: 0 };
const text = (patch: Partial<TextEntity> = {}): TextEntity => ({ id: 'text', type: 'text', layer: '0', color: 3, style: 'FACE', position: { x: 0, y: 0 }, text: 'A', height: 1, rotation: 0, align: 'left', ...patch });
const line: Entity = { id: 'line', type: 'line', layer: '0', color: 3, a: { x: -2, y: -2 }, b: { x: 2, y: -2 } };
const dimension = (): DimensionEntity => ({ id: 'dim', type: 'dimension', kind: 'linear', layer: '0', color: 3, p1: { x: 0, y: 0 }, p2: { x: 8, y: 1 }, linePoint: { x: 4, y: 4 }, rotation: 0, style: { ...STANDARD_DIMSTYLE, textStyle: 'FACE' }, text: 'A' });
const state = (objects: readonly Entity[], blocks: Readonly<Record<string, BlockDef>> = {}): DrawingState => sealImmutableData({ entities: objects, blocks, layers: [{ name: '0', color: 3, visible: true, locked: false, lineWeight: 0.25 }], currentLayer: '0' });
const context = (appearance: TextAppearance = stroke): TextGeometryContext => ({
  cacheKey: {}, resolve: vi.fn(() => appearance),
  measure: vi.fn(() => { throw new Error('Uncertified native metrics must not be consumed by a Hershey GPU scene'); }),
});
const lookup = (source: DrawingState, geometry: TextGeometryContext, definitions = source.blocks): BlockLookup => Object.assign((name: string) => definitions[name], { textGeometry: geometry });
const hatch = (kind?: number): HatchEntity => ({ id: 'hatch', type: 'hatch', layer: '0', color: 3, solid: false, pattern: 'LINE', scale: 1, angle: 0, loops: [{ points: [{ x: 0, y: 0 }, { x: 8, y: 0 }, { x: 8, y: 8 }, { x: 0, y: 8 }] }], gradient: { name: 'LINEAR', angle: 0, shift: 0, singleColor: false, tint: 0, colors: [{ position: 0, trueColor: 0xff0000 }, { position: 1, trueColor: 0x0000ff }], ...(kind !== undefined ? { kind } : {}) } });
afterEach(() => vi.restoreAllMocks());

describe('GPU captured display-only text context', () => {
  it('binds a Hershey scene to the exact captured context and key without using native ink', () => {
    const source = state([line, text()]), geometry = context(), before = JSON.stringify(source);
    const result = lowerStrokeScene(source, view, overlay, { lookup: lookup(source, geometry) });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.cause;
    expect(result.textGeometryDependency).toBe(geometry); expect(result.metricKeyDependency).toBe(geometry.cacheKey);
    expect(geometry.resolve).toHaveBeenCalled(); expect(geometry.measure).not.toHaveBeenCalled();
    expect(JSON.stringify(source)).toBe(before);
  });

  it.each([1, 0.01])('refuses the whole same-state scene when the captured native font changes, including QTEXT height%s', height => {
    const source = state([line, text({ height })]);
    expect(lowerStrokeScene(source, view, overlay, { lookup: lookup(source, context()) }).ok).toBe(true);
    const geometry = context(native), result = lowerStrokeScene(source, view, overlay, { lookup: lookup(source, geometry) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('Canvas font') });
    expect(result).not.toHaveProperty('operations'); expect(geometry.measure).not.toHaveBeenCalled();
  });

  it('resolves original WORLD and rebased TEXT through the same captured context', () => {
    const source = state([text({ position: { x: 100, y: 30 }, firstAlignmentPoint: { x: 100, y: 30 }, alignmentPoint: { x: 108, y: 30 }, justification: { horizontal: 5, vertical: 0 }, widthFactor: 1.2, oblique: 0.05 })]);
    const geometry = context(), result = lowerStrokeScene(source, { ...view, center: { x: 100, y: 30 } }, overlay, { lookup: lookup(source, geometry) });
    expect(result.ok).toBe(true);
    const calls = vi.mocked(geometry.resolve).mock.calls.map(([input]) => input as TextEntity);
    expect(calls.some(input => input.position.x === 0 && input.position.y === 0)).toBe(true);
    expect(calls.some(input => input.position.x === 100 && input.position.y === 30)).toBe(true);
  });

  it('refuses a key changed during preparation before returning any accumulated operations', () => {
    let key: object = {}, changed = false;
    const geometry: TextGeometryContext = { get cacheKey() { return key; }, resolve() { if (!changed) { key = {}; changed = true; } return stroke; }, measure: () => ({ advance: 1, left: 0, right: 1, ascent: 1, descent: 0 }) };
    const source = state([line, text()]), result = lowerStrokeScene(source, view, overlay, { lookup: lookup(source, geometry) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('context changed') });
    expect(result).not.toHaveProperty('operations');
  });

  it('uses captured block definitions and context for both transformed text and attributes', () => {
    const block: BlockDef = { name: 'CAPTURED', basePoint: { x: 0, y: 0 }, entities: [text({ id: 'child', position: { x: 1, y: 1 }, text: 'CHILD' })], attributes: [{ tag: 'A', prompt: '', default: 'ATTR', style: 'FACE', position: { x: 2, y: 1 }, height: 1, align: 'left' }] };
    const insert: InsertEntity = { id: 'insert', type: 'insert', layer: '0', color: 3, block: block.name, position: { x: 10, y: 3 }, scale: 2, rotation: 0.25, attributes: {} };
    const source = state([insert]), geometry = context(), captured = lookup(source, geometry, { CAPTURED: block });
    const result = lowerStrokeScene(source, { ...view, center: insert.position }, overlay, { lookup: captured });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.cause;
    expect(result.blockDependencies.get(block.name)).toBe(block);
    const calls = vi.mocked(geometry.resolve).mock.calls.map(([input]) => input as TextEntity);
    for (const value of ['CHILD', 'ATTR']) {
      const paired = calls.filter(input => input.text === value);
      expect(paired).toHaveLength(2); expect(paired[0]!.position).not.toEqual(paired[1]!.position);
    }
    expect(source.blocks).toEqual({});
  });

  it('refuses a loaded SHX attribute without exposing earlier line operations or evaluating its program', () => {
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [{ tag: 'A', prompt: '', default: 'A', style: 'LOADED', position: { x: 1, y: 1 }, height: 1, align: 'left' }] };
    const insert: InsertEntity = { id: 'insert', type: 'insert', layer: '0', color: 3, block: 'B', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} };
    const geometry: TextGeometryContext = { ...context(), resolve: input => input.style === 'LOADED' ? { ...stroke, shxResourceId: 'private-authored-resource' } : stroke, shxRun: vi.fn(() => { throw new Error('GPU must not evaluate uncertified SHX'); }) };
    const source = state([line, insert], { B: block }), result = lowerStrokeScene(source, view, overlay, { lookup: lookup(source, geometry) });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('SHX') });
    expect(result).not.toHaveProperty('operations'); expect(geometry.shxRun).not.toHaveBeenCalled();
  });

  it('falls back after a real authored SHX load without changing the drawing state/history, while an older captured context stays coherent', async () => {
    const fonts = new DrawingShxResources();
    const doc = new Drawing({ entities: [line, text()], meta: { textStyles: { FACE: { ...STANDARD_TEXT_STYLE, name: 'FACE', font: 'authored.shx' } } } }, definitions => fonts.geometry(definitions));
    const source = doc.snapshot, history = doc.history(), before = JSON.stringify(source), geometry = doc.lookupBlock.textGeometry!, oldKey = geometry.cacheKey;
    const captured = lookup(source, fonts.capture(textStylesOf(source)));
    expect(lowerStrokeScene(source, view, overlay, { lookup: doc.lookupBlock }).ok).toBe(true);
    const bytes = shxFixture(), resolvedPath = String.raw`C:\private\authored.shx`, sha256 = createHash('sha256').update(bytes).digest('hex');
    await fonts.load({ bytes, resolvedPath, sha256, resourceId: JSON.stringify([resolvedPath, sha256]) });
    expect(doc.snapshot).toBe(source); expect(doc.history()).toEqual(history); expect(JSON.stringify(source)).toBe(before);
    expect(doc.lookupBlock.textGeometry).toBe(geometry); expect(geometry.cacheKey).not.toBe(oldKey);
    const result = lowerStrokeScene(source, view, overlay, { lookup: doc.lookupBlock });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('SHX') }); expect(result).not.toHaveProperty('operations');
    expect(lowerStrokeScene(source, view, overlay, { lookup: captured }).ok).toBe(true);
  });

  it('passes the captured context through local/WORLD dimension layout and binds the native source certificate', () => {
    const entity = dimension(), source = state([entity]), geometry = context(), captured = lookup(source, geometry);
    const spy = vi.spyOn(entities, 'dimensionParts');
    const lowered = lowerDimensionStrokes(entity, source, { lookup: captured, anchor: view.center, widthCss: 1, nativeView: view, minRatio: 0.8, maxRatio: 1.25 });
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) throw lowered.cause;
    expect(spy).toHaveBeenCalledWith(entity, geometry); expect(spy.mock.calls.every(([, actual]) => actual === geometry)).toBe(true);
    expect(lowered.nativeSourceCertificate!.textGeometryDependency).toBe(geometry);
    expect(lowered.nativeSourceCertificate!.metricKeyDependency).toBe(geometry.cacheKey);
    const result = lowerStrokeScene(source, view, overlay, { lookup: captured });
    expect(result.ok).toBe(true);
    expect(geometry.measure).not.toHaveBeenCalled();
  });

  it.each([native, { ...stroke, shxResourceId: 'private-authored-resource' }])('refuses uncertified dimension font context in lowerer, independent certificate and whole scene', appearance => {
    const entity = dimension(), source = state([line, entity]), captured = lookup(source, context(appearance));
    const localParts = dimensionParts(entity);
    expect(lowerDimensionStrokes(entity, source, { lookup: captured, anchor: view.center, widthCss: 1, nativeView: view }).ok).toBe(false);
    expect(() => certifyDimensionNativeSource(entity, localParts, source, { lookup: captured, view, widthCss: 1, minRatio: 0.8, maxRatio: 1.25, maxPoints: 4096, maxParts: 256 })).toThrow(/Canvas|SHX/);
    const result = lowerStrokeScene(source, view, overlay, { lookup: captured }); expect(result.ok).toBe(false); expect(result).not.toHaveProperty('operations');
  });
});

describe('GPU whole-scene gradient fallback', () => {
  it.each([undefined, 1, 2])('refuses active native gradient kind%s before exposing any line or hatch operations', kind => {
    const entity = hatch(kind), source = state([line, entity]), before = JSON.stringify(source);
    expect(lowerHatchStrokes(entity, view)).toMatchObject({ ok: false, reason: expect.stringContaining('gradient') });
    const result = lowerStrokeScene(source, view, overlay); expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('gradient') }); expect(result).not.toHaveProperty('operations');
    expect(JSON.stringify(source)).toBe(before);
  });

  it('retains an inactive descriptor and exactly the ordinary pattern geometry', () => {
    const inactive = hatch(0), { gradient: _gradient, ...ordinary } = inactive;
    const first = state([inactive]), second = state([ordinary]), before = JSON.stringify(first);
    const a = lowerStrokeScene(first, view, overlay), b = lowerStrokeScene(second, view, overlay);
    expect(a.ok).toBe(true); expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('Authored ordinary LINE pattern must be admitted');
    expect(a.operations).toEqual(b.operations); expect(JSON.stringify(first)).toBe(before);
  });
});
