import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Drawing, DEFAULT_HEADER, type DrawingState } from '../src/core/document';
import type { BlockDef, Entity } from '../src/core/entities';
import {
  dimStyleUsage,
  findDimStyle,
  resolveDimStyle,
  STANDARD_DIMSTYLE,
  withDimStyle,
  withoutDimStyle,
  type DimensionEntity,
  type DimStyle,
} from '../src/core/dimension';
import { defaultLayout } from '../src/core/layouts';
import { readDxf, writeDxf } from '../src/io/dxf';
import { dimstyleCommandTool } from '../src/tools/dimension';
import { drive, fakeContext } from './fake-context';

const named: DimStyle = { ...STANDARD_DIMSTYLE, name: 'Sheet' };
const dimension = (id: string, style: DimStyle = named): DimensionEntity => ({
  id, type: 'dimension', kind: 'linear', layer: '0', color: 'ByLayer',
  p1: { x: 0, y: 0 }, p2: { x: 4, y: 0 }, linePoint: { x: 2, y: 2 }, rotation: 0, style,
});
const block = (name: string, entities: readonly Entity[]): BlockDef => ({ name, basePoint: { x: 0, y: 0 }, attributes: [], entities });
const insert = (id: string, name: string): Entity => ({ id, type: 'insert', block: name, layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, scale: 1, rotation: 0, attributes: {} });
const state = (): DrawingState => withDimStyle({
  entities: [dimension('model'), insert('insert-1', 'NESTED'), insert('insert-2', 'NESTED')],
  layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
  currentLayer: '0',
  header: DEFAULT_HEADER,
  blocks: {
    NESTED: block('NESTED', [insert('child', 'DETAIL')]),
    DETAIL: block('DETAIL', [dimension('block', { ...named, textHeight: 0.8, decimals: 2, arrow: 'dot' })]),
    UNRELATED: block('UNRELATED', [{ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 1, y: 0 } }]),
  },
  layouts: [
    { ...defaultLayout('Layout1'), entities: [dimension('paper-1')], pristine: false },
    { ...defaultLayout('Layout2'), entities: [dimension('paper-2', { ...named, textColor: 3 })], pristine: false },
  ],
}, named, false);
const dimensions = (s: DrawingState): DimensionEntity[] => [
  ...s.entities,
  ...Object.values(s.blocks).flatMap((b) => b.entities),
  ...(s.layouts ?? []).flatMap((l) => l.entities),
].filter((e): e is DimensionEntity => e.type === 'dimension');

describe('named dimension styles across the complete drawing', () => {
  it('counts stored dimensions in model space, block definitions and every paper layout once', () => {
    expect(dimStyleUsage(state(), 'sHeEt')).toBe(4);
    expect(dimStyleUsage(state(), 'Missing')).toBe(0);
  });

  it.each(['block', 'paper'] as const)('prevents deletion when the only reference is in %s space', (where) => {
    const source = state();
    const referenced: DrawingState = {
      ...source,
      entities: [],
      blocks: where === 'block' ? { UNUSED: block('UNUSED', [dimension('unused-block')]) } : {},
      layouts: [{ ...defaultLayout('Layout1'), entities: where === 'paper' ? [dimension('paper')] : [] }],
    };
    expect(dimStyleUsage(referenced, named.name)).toBe(1);
    expect(withoutDimStyle(referenced, named.name)).toBe(referenced);
  });

  it('updates inherited properties everywhere and preserves entity overrides and unrelated immutable data', () => {
    const original = new Drawing(state()).snapshot;
    const replacement: DimStyle = { ...named, name: 'SHEET', textHeight: 0.3, extExtend: 0.6, textColor: 1, arrow: 'open' };
    const next = withDimStyle(original, replacement);
    expect(dimensions(next).map((d) => d.style.extExtend)).toEqual([0.6, 0.6, 0.6, 0.6]);
    expect(dimensions(next).map((d) => d.style.name)).toEqual(['SHEET', 'SHEET', 'SHEET', 'SHEET']);
    expect(dimensions(next).map((d) => d.style.textHeight)).toEqual([0.3, 0.8, 0.3, 0.3]);
    expect(dimensions(next).map((d) => d.style.textColor)).toEqual([1, 1, 1, 3]);
    const overridden = next.blocks.DETAIL!.entities[0] as DimensionEntity;
    expect(resolveDimStyle(overridden.style)).toMatchObject({ arrow: 'dot', arrow2: 'dot', decimals: 2 });
    expect(next.blocks.UNRELATED).toBe(original.blocks.UNRELATED);
    expect(next.blocks.NESTED).toBe(original.blocks.NESTED);
    expect(next.layouts![0]!.viewports).toBe(original.layouts![0]!.viewports);
    expect(next.layers).toBe(original.layers);
    expect(dimensions(original).map((d) => d.style.extExtend)).toEqual([0.18, 0.18, 0.18, 0.18]);
    expect(findDimStyle(original, named.name)).toEqual(named);
  });

  it('treats explicit default values as inherited and preserves an overridden second-arrow fallback', () => {
    const base: DimStyle = { ...named, arrow: 'dot', arrow2: 'closed-filled' };
    const effective: DimStyle = { ...base, arrow2: undefined, suppressExt1: false };
    const source = withDimStyle({ ...state(), entities: [dimension('fallback', effective)] }, base, false);
    const next = withDimStyle(source, { ...base, arrow: 'open', suppressExt1: true });
    const d = next.entities[0] as DimensionEntity;
    expect(resolveDimStyle(d.style)).toMatchObject({ arrow: 'open', arrow2: 'dot', suppressExt1: true });
  });

  it('preserves existing effective values when registering a style without a known previous base', () => {
    const original = dimension('unregistered', { ...named, textColor: 3, arrow: 'dot' });
    const source: DrawingState = { entities: [original], layers: [], blocks: {}, currentLayer: '0' };
    const next = withDimStyle(source, { ...named, textHeight: 1, suppressExt1: true, arrow: 'open' });
    expect(resolveDimStyle((next.entities[0] as DimensionEntity).style)).toEqual(resolveDimStyle(original.style));
    expect(findDimStyle(next, named.name)?.textHeight).toBe(1);
  });

  it('uses the Standard named base rather than temporary current-variable overrides', () => {
    const changedCurrent = { ...STANDARD_DIMSTYLE, textHeight: 1 };
    const source: DrawingState = {
      ...new Drawing().snapshot,
      entities: [dimension('inherited', STANDARD_DIMSTYLE), dimension('overridden', { ...STANDARD_DIMSTYLE, textHeight: 0.8 })],
      header: { ...DEFAULT_HEADER, dimStyle: changedCurrent },
    };
    const next = withDimStyle(source, changedCurrent);
    expect(dimensions(next).map((d) => d.style.textHeight)).toEqual([1, 0.8]);
  });

  it('keeps all entity containers untouched when only the named record is changed', () => {
    const original = new Drawing(state()).snapshot;
    const next = withDimStyle(original, { ...named, textHeight: 1 }, false);
    expect(next.entities).toBe(original.entities);
    expect(next.blocks).toBe(original.blocks);
    expect(next.layouts).toBe(original.layouts);
    expect(findDimStyle(next, named.name)?.textHeight).toBe(1);
  });

  it('ignores malformed unrelated style records without discarding their retained metadata', () => {
    const opaque = { retained: 'unknown style data' };
    const original = { ...state(), meta: { dimStyles: { broken: null, opaque, Sheet: named } } };
    const next = withDimStyle(original, { ...named, textHeight: 1 });
    expect(findDimStyle(next, named.name)?.textHeight).toBe(1);
    expect((next.meta!.dimStyles as Record<string, unknown>).opaque).toBe(opaque);
    expect((next.meta!.dimStyles as Record<string, unknown>).broken).toBeNull();
  });
});

describe('whole-drawing style transactions while editing paper space', () => {
  it('updates hidden model dimensions, block definitions and both layouts in one immutable undo/redo step', () => {
    const doc = new Drawing({ ...state(), space: { layout: 'Layout1' } });
    const before = doc.snapshot;
    const revision = doc.revision;
    const replacement = { ...named, extExtend: 0.6, textHeight: 0.3 };
    doc.transactDrawing((s) => withDimStyle(s, replacement));
    const after = doc.snapshot;
    expect(doc.dirty).toBe(true);
    expect(doc.revision).toBe(revision + 1);
    expect(dimensions(after).map((d) => d.style.extExtend)).toEqual([0.6, 0.6, 0.6, 0.6]);
    expect(after.space).toBe(before.space);
    expect(doc.entities[0]!.id).toBe('paper-1');
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.redo()).toBe(true);
    expect(doc.snapshot).toBe(after);
    expect((doc.blocks.DETAIL!.entities[0] as DimensionEntity).style.textHeight).toBe(0.8);
  });

  it('keeps ordinary editing transactions scoped to the active paper layout', () => {
    const doc = new Drawing({ ...state(), space: { layout: 'Layout1' } });
    const originalModel = doc.snapshot.entities;
    doc.addEntities([dimension('new-paper')]);
    expect(doc.snapshot.entities).toBe(originalModel);
    expect(doc.entities.map((e) => e.id)).toEqual(['paper-1', 'new-paper']);
    expect(doc.snapshot.layouts![1]!.entities.map((e) => e.id)).toEqual(['paper-2']);
    expect(doc.undo()).toBe(true);
    expect(doc.entities.map((e) => e.id)).toEqual(['paper-1']);
  });

  it('keeps no-ops and rejected whole-drawing transitions out of history and preserves redo', () => {
    const doc = new Drawing(state());
    let notifications = 0;
    doc.subscribe(() => { notifications += 1; });
    doc.transactDrawing((s) => s);
    expect(doc.dirty).toBe(false);
    expect(doc.revision).toBe(0);
    expect(doc.canUndo()).toBe(false);
    expect(notifications).toBe(0);
    doc.transactDrawing((s) => withDimStyle(s, { ...named, extExtend: 0.6 }));
    doc.undo();
    const before = doc.snapshot;
    const revision = doc.revision;
    const count = notifications;
    expect(() => doc.transactDrawing((s) => ({ ...s, entities: [{ id: 'bad', type: 'text', layer: '0', color: 'ByLayer', position: { x: 0, y: 0 }, text: 'X'.repeat(1_000_001), height: 0.18, rotation: 0, align: 'left' }] }))).toThrow(/Drawing expansion/);
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revision);
    expect(notifications).toBe(count);
    expect(doc.canRedo()).toBe(true);
    expect(doc.redo()).toBe(true);
  });

  it('applies the existing 200-step undo budget to whole-drawing transitions', () => {
    const doc = new Drawing();
    for (let i = 1; i <= 205; i += 1) doc.transactDrawing((s) => ({ ...s, meta: { step: i } }));
    let undos = 0;
    while (doc.undo()) undos += 1;
    expect(undos).toBe(200);
    expect(doc.snapshot.meta?.step).toBe(5);
  });

  it('uses the complete drawing for command-line named-style Save from paper space', () => {
    const doc = new Drawing({ ...state(), space: { layout: 'Layout1' } });
    doc.setHeader({ dimStyle: { ...named, textHeight: 0.3, extExtend: 0.6 } });
    const ctx = fakeContext(doc);
    drive(dimstyleCommandTool('Save Sheet'), ctx, []);
    expect(dimensions(doc.snapshot).map((d) => d.style.extExtend)).toEqual([0.6, 0.6, 0.6, 0.6]);
    expect((doc.blocks.DETAIL!.entities[0] as DimensionEntity).style.textHeight).toBe(0.8);
    expect(doc.undo()).toBe(true);
    expect(findDimStyle(doc.snapshot, named.name)?.extExtend).toBe(named.extExtend);
    expect(dimensions(doc.snapshot).map((d) => d.style.extExtend)).toEqual([0.18, 0.18, 0.18, 0.18]);
    // Current variables remain outside history, as they do for other dimension-variable commands.
    expect(doc.header.dimStyle.extExtend).toBe(0.6);
  });
});

describe('imported native dimension-style overrides after global redefinition', () => {
  it('keeps the independently authored fixture override in model, block and paper space through save/reopen', () => {
    const source = readDxf(readFileSync(join(__dirname, 'fixtures', 'interchange', 'r2018-dimensions.dxf'), 'utf8'));
    const overridden = source.entities.find((e): e is DimensionEntity => e.type === 'dimension' && e.p1.y === 120)!;
    expect(overridden.style).toMatchObject({ name: 'ISO-25', textHeight: 5, decimals: 0 });
    const base = findDimStyle(source, 'ISO-25')!;
    const doc = new Drawing({
      ...source,
      blocks: { ...source.blocks, DIMBLOCK: block('DIMBLOCK', [{ ...overridden, id: 'block-override' }]) },
      layouts: [{ ...defaultLayout('Paper'), entities: [{ ...overridden, id: 'paper-override' }], pristine: false }],
      space: { layout: 'Paper' },
    });
    doc.transactDrawing((s) => withDimStyle(s, { ...base, textHeight: 3, extExtend: 4 }));
    const saved = writeDxf(doc.snapshot);
    const reopened = readDxf(saved);
    expect(findDimStyle(reopened, 'ISO-25')).toMatchObject({ textHeight: 3, extExtend: 4 });
    const retained = dimensions(reopened).filter((d) => d.p1.y === 120);
    expect(retained).toHaveLength(3);
    for (const d of retained) expect(d.style).toMatchObject({ name: 'ISO-25', textHeight: 5, decimals: 0, extExtend: 4 });
  });
});
