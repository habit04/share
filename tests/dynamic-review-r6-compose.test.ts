/**
 * Review round 6, R5-01 — composing a recorded transform must not let a
 * NON-ATTRIBUTE anchor's image overflow while the attribute's own
 * placement stays finite.
 *
 * The defect: composition kept the FIRST action's anchor and computed
 * that anchor's image through the next action. For a π rotation about
 * (1e308, 0) followed by a scale of 2 about the origin, the anchor is
 * the rotation centre — not an attribute point — and its image is
 * 2·1e308 = Infinity, while the attribute itself (whose delta from the
 * centre is halved by the rotation before the scale sees it) stays
 * finite. The record carried (Infinity, NaN) into the expansion of a
 * genuine colour-only override, and a parameter edit committed that
 * nonfinite geometry.
 *
 * The contract pinned here: when the composed record at the kept anchor
 * is non-finite, composition re-anchors the SAME map at the attribute's
 * authored position, whose image is computed stepwise through both
 * anchored forms (the evaluator's own application order for that
 * point), and the record's finiteness is validated where it is
 * produced — an evaluation whose record has no finite representation
 * refuses 'degenerate-transform' atomically instead of succeeding.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { explodeInsert, type AttributeDef, type BlockDef, type InsertEntity, type TextEntity } from '../src/core/entities';
import { validateDefinition, type DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import { setDynamicParameter } from '../src/core/parametric/apply';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { readDxf, writeDxf } from '../src/io/dxf';

const angleParam = {
  kind: 'angle', id: 'angle', name: 'Angle', basePoint: { x: 0, y: 0 }, defaultValue: 0,
  constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }],
} as const;
const distanceParam = (id: string) => ({
  kind: 'linear-distance', id, name: id, basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 1,
  constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }],
} as const);

function build(
  attribute: AttributeDef,
  def: DynamicBlockDefinition,
  values: DynamicInstanceState['values'],
): { doc: Drawing; insert: InsertEntity } {
  const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attribute], dynamic: def };
  const insert: InsertEntity = {
    id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1,
    attributes: { TAG: 'USER-TAG' }, attributePlacements: { TAG: { ...attribute, color: 1 } },
    dynamic: { block: 'B', values },
  };
  return { doc: new Drawing({ entities: [insert], blocks: { B: block } }), insert };
}

function text(doc: Drawing): TextEntity {
  const item = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
    .find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
  if (!item) throw new Error('Expected genuine color-only USER-TAG');
  return item;
}
const finiteText = (item: TextEntity): boolean =>
  [item.position.x, item.position.y, item.height, item.rotation ?? 0].every(Number.isFinite);

describe('round6 composed-anchor re-anchoring (R5-01)', () => {
  it('rotate then scale succeeds after re-anchoring at a second huge centre', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 7.5e307, y: 0 }, height: 2, align: 'left', rotation: 0.25,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [angleParam, distanceParam('size')],
      actions: [
        { kind: 'rotate', id: 'R', name: 'R', parameterId: 'angle', center: { x: 5e307, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    // Kept-anchor image would be 4 * 5e307 = Infinity; the attribute's
    // own stepwise image is (5e307 - 2.5e307) * 4 = 1e308, finite.
    const { doc, insert } = build(attribute, def, {
      angle: { kind: 'angle', value: Math.PI }, size: { kind: 'distance', value: 4 },
    });
    const evaluation = evaluateDynamicBlock(def, [], [attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    const displayed = text(doc);
    expect(finiteText(displayed)).toBe(true);
    expect(displayed.color).toBe(1);
    expect(displayed.position.x / 1e308).toBeCloseTo(1, 9);
    expect(displayed.height).toBeCloseTo(8, 9);
    const recorded = evaluation.attributeTransforms.get('TAG')!;
    expect(recorded.ax).toBe(7.5e307); // re-anchored at the authored position
    expect(Number.isFinite(recorded.ix)).toBe(true);
  });

  it('scale then rotate (opposite order) also re-anchors and stays finite', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 4e307, y: 0 }, height: 2, align: 'left', rotation: 0.25,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [angleParam, distanceParam('size')],
      actions: [
        { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'rotate', id: 'R', name: 'R', parameterId: 'angle', center: { x: 1e308, y: 0 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    // Kept anchor is the scale's origin; its image under the rotation
    // is (2e308, 0) = Infinity. Stepwise: 4e307 * 2 = 8e307, then
    // rotated about (1e308, 0) to 1.2e308 — finite.
    const { doc, insert } = build(attribute, def, {
      angle: { kind: 'angle', value: Math.PI }, size: { kind: 'distance', value: 2 },
    });
    const evaluation = evaluateDynamicBlock(def, [], [attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    const displayed = text(doc);
    expect(finiteText(displayed)).toBe(true);
    expect(displayed.color).toBe(1);
    expect(displayed.position.x / 1.2e308).toBeCloseTo(1, 9);
    expect(displayed.height).toBeCloseTo(4, 9);
  });

  it('a three-action chain (rotate, scale, rotate) keeps a finite record', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 1.5e308, y: 0 }, height: 2, align: 'left', rotation: 0.25,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [angleParam, distanceParam('size')],
      actions: [
        { kind: 'rotate', id: 'R1', name: 'R1', parameterId: 'angle', center: { x: 1e308, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'rotate', id: 'R2', name: 'R2', parameterId: 'angle', center: { x: 1e308, y: 0 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    const { doc, insert } = build(attribute, def, {
      angle: { kind: 'angle', value: Math.PI }, size: { kind: 'distance', value: 2 },
    });
    const evaluation = evaluateDynamicBlock(def, [], [attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    expect(evaluation.appliedActions).toEqual(['R1', 'S', 'R2']);
    const displayed = text(doc);
    expect(finiteText(displayed)).toBe(true);
    expect(displayed.color).toBe(1);
    // (1.5e308 -> 0.5e308 -> 1e308) rotated about (1e308, 0): back to x = 1e308.
    expect(displayed.position.x / 1e308).toBeCloseTo(1, 9);
    expect(displayed.height).toBeCloseTo(4, 9);
  });

  it('an unrepresentable composition refuses atomically at evaluation and at edit', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 1, y: 0 }, height: 2, align: 'left', rotation: 0,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [distanceParam('s1'), distanceParam('s2')],
      actions: [
        { kind: 'scale', id: 'S1', name: 'S1', parameterId: 's1', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'S2', name: 'S2', parameterId: 's2', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    // 1e160 * 1e160 leaves the finite range in the geometry itself and
    // in the composed record alike: the safe outcome is one explicit
    // atomic refusal, never a successful nonfinite commit. The stored
    // state carries s2 = 1e160 alone (finite: position 1e160, height
    // 2e160); the edit drives s1 to 1e160, composing the two.
    const { doc, insert } = build(attribute, def, {
      s1: { kind: 'distance', value: 1 }, s2: { kind: 'distance', value: 1e160 },
    });
    const before = doc.snapshot;
    const revision = doc.revision;
    const direct = evaluateDynamicBlock(def, [], [attribute], {
      block: 'B',
      values: { s1: { kind: 'distance', value: 1e160 }, s2: { kind: 'distance', value: 1e160 } },
    });
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.refusal.code).toBe('degenerate-transform');
    const result = setDynamicParameter(before, 'top', 's1', 1e160);
    expect(result.problem).toBeDefined();
    expect(result.state).toBe(before);
    expect(doc.revision).toBe(revision);
    expect(insert.dynamic).toBeDefined();
  });

  it('the re-anchored success case is a DXF fixed point', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 1.5e308, y: 0 }, height: 2, align: 'left', rotation: 0.25,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [angleParam, distanceParam('size')],
      actions: [
        { kind: 'rotate', id: 'R', name: 'R', parameterId: 'angle', center: { x: 1e308, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    const { doc } = build(attribute, def, {
      angle: { kind: 'angle', value: Math.PI }, size: { kind: 'distance', value: 2 },
    });
    const dxf = writeDxf(doc.snapshot);
    expect(() => readDxf(dxf)).not.toThrow();
    const saved = new Drawing(readDxf(dxf));
    const stored = (saved.entities[0] as InsertEntity).attributePlacements!.TAG!;
    expect(stored.position.x / 1.5e308).toBeCloseTo(1, 9);
    expect(stored.height).toBeCloseTo(2, 9);
    const displayed = text(saved);
    expect(finiteText(displayed)).toBe(true);
    expect(displayed.color).toBe(1);
    expect(displayed.position.x / 1e308).toBeCloseTo(1, 9);
  });
});
