/**
 * Review round 2, C05 — coherent FULL text-placement transforms for
 * dynamic-block attributes.
 *
 * The defect: evaluation moved only AttributeDef.position and left
 * alignmentPoint / firstAlignmentPoint at their authored values, so an
 * evaluated definition was internally incoherent. For right/center/fit
 * justifications the text anchor IS the alignment point (or the pair of
 * anchors), and the direct expansion, the DXF writer and the reader's
 * R07 placement rebase then disagreed — a saved/reopened instance and a
 * never-saved one matched at the saved state but diverged after the
 * next parameter edit.
 *
 * The contract pinned here: an action that moves an attribute moves its
 * WHOLE placement by the same transform the core applies to a text
 * entity (every anchor; scale also scales height; rotate also advances
 * rotation), so the saved path and the direct path are the same function
 * of state — through repeated save/reopen/edit cycles.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { explodeInsert, type AttributeDef, type BlockDef, type InsertEntity, type TextEntity } from '../src/core/entities';
import { textAnchor } from '../src/core/text-placement';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import { readDxf, writeDxf } from '../src/io/dxf';

const stretchDef = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [{ kind: 'linear-distance', id: 'width', name: 'Width', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10,
    constraint: { kind: 'range', min: 5, max: 20 }, grips: [{ role: 'value', movesWithValue: true }] }],
  actions: [{ kind: 'stretch', id: 'stretch', name: 'Stretch', parameterId: 'width', frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [{ entityId: 'line', points: { kind: 'frame' } }, { entityId: 'TAG', points: { kind: 'frame' } }] }],
});

const blockWith = (attr: Partial<AttributeDef>): BlockDef => ({ name: 'CHILD', basePoint: { x: 0, y: 0 },
  entities: [{ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
  attributes: [{ tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 6, y: 1 }, height: 1, align: 'left', ...attr }],
  dynamic: stretchDef() });

const insert = (width = 14): InsertEntity => ({ id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'CHILD',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
  dynamic: { block: 'CHILD', values: { width: { kind: 'distance', value: width } } } });

const tagText = (doc: Drawing): TextEntity => {
  const ins = doc.entities[0] as InsertEntity;
  const found = explodeInsert(ins, doc.lookupBlock).find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
  if (!found) throw new Error('missing expanded TAG');
  return found;
};

const roundTrip = (doc: Drawing): Drawing => new Drawing(readDxf(writeDxf(doc.snapshot)));

const editWidth = (doc: Drawing, width: number): Drawing => {
  const result = setDynamicParameter(doc.snapshot, (doc.entities[0] as InsertEntity).id, 'width', width);
  expect(result.problem).toBeUndefined();
  return new Drawing(result.state);
};

describe('C05 — justified attributes: saved and direct paths are the same function of state', () => {
  it('right-justified: anchors agree through repeated save/reopen/edit cycles', () => {
    const block = blockWith({ align: 'right', justification: { horizontal: 2, vertical: 0 }, alignmentPoint: { x: 6, y: 1 }, firstAlignmentPoint: { x: 0, y: 0 } });
    let direct = new Drawing({ entities: [insert()], blocks: { CHILD: block } });
    let saved = roundTrip(direct);
    // Authored alignment point is x6; width 14 stretches it +4.
    expect(textAnchor(tagText(direct))).toEqual({ x: 10, y: 1 });
    expect(textAnchor(tagText(saved))).toEqual(textAnchor(tagText(direct)));
    for (const width of [18, 10, 16]) {
      direct = editWidth(direct, width);
      saved = editWidth(saved, width);
      expect(textAnchor(tagText(saved))).toEqual(textAnchor(tagText(direct)));
      // Exact expectation: anchor = authored 6 + (width - default 10).
      expect(textAnchor(tagText(direct))).toEqual({ x: 6 + (width - 10), y: 1 });
      saved = roundTrip(saved);
      expect(textAnchor(tagText(saved))).toEqual(textAnchor(tagText(direct)));
    }
  });

  it('center-justified: the alignment point rides the stretch identically in both paths', () => {
    const block = blockWith({ align: 'center', justification: { horizontal: 1, vertical: 0 }, alignmentPoint: { x: 6, y: 1 } });
    const direct = new Drawing({ entities: [insert()], blocks: { CHILD: block } });
    const saved = roundTrip(direct);
    expect(textAnchor(tagText(saved))).toEqual(textAnchor(tagText(direct)));
    const editedDirect = editWidth(direct, 18);
    const editedSaved = editWidth(saved, 18);
    expect(textAnchor(tagText(editedDirect))).toEqual({ x: 14, y: 1 });
    expect(textAnchor(tagText(editedSaved))).toEqual({ x: 14, y: 1 });
  });

  it('fit-justified: a stretch translates the whole placement, preserving the anchor span', () => {
    // Canonical fit placement (the DXF two-point model): position IS the
    // first fit point, alignmentPoint the second; the span between them
    // is what the text is fitted to.
    const block = blockWith({ align: 'left', justification: { horizontal: 5, vertical: 0 }, alignmentPoint: { x: 16, y: 1 } });
    const result = evaluateDynamicBlock(stretchDef(), block.entities, block.attributes,
      { block: 'CHILD', values: { width: { kind: 'distance', value: 14 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.attributes[0]!;
    expect(a.position).toEqual({ x: 10, y: 1 });
    expect(a.alignmentPoint).toEqual({ x: 20, y: 1 });
    // Span (alignmentPoint - position) is unchanged by the move.
    expect(a.alignmentPoint!.x - a.position.x).toBe(10);
    // And the saved path agrees after a further edit.
    const direct = new Drawing({ entities: [insert()], blocks: { CHILD: block } });
    const saved = roundTrip(direct);
    const tagSpan = (t: TextEntity) => (t.alignmentPoint!.x - t.position.x);
    expect(tagSpan(tagText(editWidth(saved, 17)))).toBe(tagSpan(tagText(editWidth(direct, 17))));
  });
});

describe('C05 — whole actions transform the full attribute placement', () => {
  const justified = (): AttributeDef[] => [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 6, y: 1 }, height: 2, align: 'right',
    justification: { horizontal: 2, vertical: 0 }, alignmentPoint: { x: 6, y: 1 }, firstAlignmentPoint: { x: 0, y: 1 }, rotation: 0.25 }];
  const entities = [{ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }] as const;

  it('move: every anchor translates; height and rotation untouched', () => {
    const def: DynamicBlockDefinition = { version: 1,
      parameters: [{ kind: 'linear-distance', id: 'slide', name: 'Slide', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10,
        constraint: { kind: 'range', min: 0, max: 30 }, grips: [{ role: 'value', movesWithValue: true }] }],
      actions: [{ kind: 'move', id: 'M1', name: 'Move', parameterId: 'slide', selection: [{ entityId: 'TAG' }] }] };
    const result = evaluateDynamicBlock(def, [...entities], justified(), { block: 'B', values: { slide: { kind: 'distance', value: 16 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.attributes[0]!;
    expect(a.position).toEqual({ x: 12, y: 1 });
    expect(a.alignmentPoint).toEqual({ x: 12, y: 1 });
    expect(a.firstAlignmentPoint).toEqual({ x: 6, y: 1 });
    expect(a.height).toBe(2);
    expect(a.rotation).toBe(0.25);
  });

  it('rotate: every anchor rotates about the centre and the text rotation advances', () => {
    const def: DynamicBlockDefinition = { version: 1,
      parameters: [{ kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 }, defaultValue: 0,
        constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }] }],
      actions: [{ kind: 'rotate', id: 'R1', name: 'Rotate', parameterId: 'swing', center: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] }] };
    const result = evaluateDynamicBlock(def, [...entities], justified(), { block: 'B', values: { swing: { kind: 'angle', value: Math.PI / 2 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.attributes[0]!;
    expect(a.position.x).toBeCloseTo(-1, 9);
    expect(a.position.y).toBeCloseTo(6, 9);
    expect(a.alignmentPoint!.x).toBeCloseTo(-1, 9);
    expect(a.alignmentPoint!.y).toBeCloseTo(6, 9);
    expect(a.firstAlignmentPoint!.x).toBeCloseTo(-1, 9);
    expect(a.firstAlignmentPoint!.y).toBeCloseTo(0, 9);
    expect(a.rotation).toBeCloseTo(0.25 + Math.PI / 2, 9);
    expect(a.height).toBe(2);
  });

  it('scale: every anchor scales about the base point and the height scales', () => {
    const def: DynamicBlockDefinition = { version: 1,
      parameters: [{ kind: 'linear-distance', id: 'slide', name: 'Slide', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10,
        constraint: { kind: 'range', min: 0, max: 40 }, grips: [{ role: 'value', movesWithValue: true }] }],
      actions: [{ kind: 'scale', id: 'SC1', name: 'Scale', parameterId: 'slide', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] }] };
    const result = evaluateDynamicBlock(def, [...entities], justified(), { block: 'B', values: { slide: { kind: 'distance', value: 20 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.attributes[0]!;
    expect(a.position).toEqual({ x: 12, y: 2 });
    expect(a.alignmentPoint).toEqual({ x: 12, y: 2 });
    expect(a.firstAlignmentPoint).toEqual({ x: 0, y: 2 });
    expect(a.height).toBe(4);
    expect(a.rotation).toBe(0.25);
  });

  it('flip: every anchor reflects across the axis (text itself stays readable)', () => {
    const def: DynamicBlockDefinition = { version: 1,
      parameters: [{ kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 5, y: 0 }, defaultValue: false }],
      actions: [{ kind: 'flip', id: 'F1', name: 'Flip', parameterId: 'handed', axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 1 }, selection: [{ entityId: 'TAG' }] }] };
    const result = evaluateDynamicBlock(def, [...entities], justified(), { block: 'B', values: { handed: { kind: 'flip', value: true } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.attributes[0]!;
    // Reflection across the vertical line x=5: x -> 10 - x.
    expect(a.position).toEqual({ x: 4, y: 1 });
    expect(a.alignmentPoint).toEqual({ x: 4, y: 1 });
    expect(a.firstAlignmentPoint).toEqual({ x: 10, y: 1 });
    expect(a.height).toBe(2);
    expect(a.rotation).toBe(0.25);
  });

  it('left-aligned without optional anchors: evaluation result is unchanged in shape', () => {
    const attrs: AttributeDef[] = [{ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 6, y: 1 }, height: 1, align: 'left' }];
    const result = evaluateDynamicBlock(stretchDef(),
      [{ id: 'line', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } }],
      attrs, { block: 'CHILD', values: { width: { kind: 'distance', value: 14 } } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes[0]).toEqual({ tag: 'TAG', prompt: 'Tag', default: 'D1', position: { x: 10, y: 1 }, height: 1, align: 'left' });
  });
});
