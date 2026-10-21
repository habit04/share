import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import {
  explodeInsert, importedPlacementsToAuthoredFrame,
  type AttributeDef, type BlockDef, type InsertEntity, type TextEntity,
} from '../src/core/entities';
import { validateDefinition, type DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import { setDynamicParameter } from '../src/core/parametric/apply';

// Round 7 (R6-01): a composed record can be finite in every field yet
// overflow when APPLIED — image + L·(q − anchor) forms the product
// before the image can cancel it, and the inverse rebase subtracts
// before it scales. These regressions pin the fix at the public paths:
// gated exponent-scaled application at the one shared application
// expression (entities.transformPlacement), the evaluator's final-
// record probe/re-anchor (step 7.6), and the edit path's placement
// probe. The packet four-case file stays the strict repro; this file
// carries the adversarial review's seven additional cases.

type Placement = AttributeDef & { color?: number };

const distance = (id: string) => ({
  kind: 'linear-distance', id, name: id, basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
  defaultValue: 1, constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }],
} as const);

/** The packet pipeline: scale ×0.5 about the origin, then ×s2 about
 *  (0.4·unit, 0), over the packet attribute at the given unit. */
function packetFixture(unit: number, second = 4, placement?: Placement) {
  const attribute: AttributeDef = {
    tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
    position: { x: unit, y: 0 },
    alignmentPoint: { x: unit * 1.1, y: 1 },
    firstAlignmentPoint: { x: unit * 0.9, y: -1 },
    height: 2, align: 'left', rotation: 0.25,
  };
  const def: DynamicBlockDefinition = {
    version: 1, parameters: [distance('s1'), distance('s2')],
    actions: [
      { kind: 'scale', id: 'S1', name: 'S1', parameterId: 's1', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
      { kind: 'scale', id: 'S2', name: 'S2', parameterId: 's2', basePoint: { x: unit * 0.4, y: 0 }, selection: [{ entityId: 'TAG' }] },
    ],
  };
  const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attribute], dynamic: def };
  const insert: InsertEntity = {
    id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1,
    attributes: { TAG: 'USER-TAG' },
    attributePlacements: { TAG: placement ?? { ...attribute, color: 1 } },
    dynamic: { block: 'B', values: { s1: { kind: 'distance', value: 0.5 }, s2: { kind: 'distance', value: second } } },
  };
  return { attribute, def, block, insert, doc: new Drawing({ entities: [insert], blocks: { B: block } }) };
}

function text(doc: Drawing): TextEntity {
  const item = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
    .find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
  if (!item) throw new Error('Missing genuine USER-TAG');
  return item;
}

function anchorsFinite(p: Pick<AttributeDef, 'position' | 'alignmentPoint' | 'firstAlignmentPoint' | 'height'>): boolean {
  return [p.position, p.alignmentPoint, p.firstAlignmentPoint].every(q => !q || [q.x, q.y].every(Number.isFinite)) &&
    Number.isFinite(p.height);
}

describe('round7 finite record application (R6-01)', () => {
  it('case 1: rotation-mix record (rotate 90° then scale ×2 about a far centre) applies forward and inverse', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 1e308, y: -1e308 },
      alignmentPoint: { x: 9e307, y: -1.1e308 },
      firstAlignmentPoint: { x: 1.1e308, y: -9e307 },
      height: 2, align: 'left', rotation: 0,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [
        { kind: 'angle', id: 'ang', name: 'ang', basePoint: { x: 0, y: 0 }, defaultValue: 0, constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }] },
        distance('k'),
      ],
      actions: [
        { kind: 'rotate', id: 'ROT', name: 'ROT', parameterId: 'ang', center: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'SCL', name: 'SCL', parameterId: 'k', basePoint: { x: 9e307, y: 9e307 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attribute], dynamic: def };
    const insert: InsertEntity = {
      id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1,
      attributes: { TAG: 'USER-TAG' }, attributePlacements: { TAG: { ...attribute, color: 1 } },
      dynamic: { block: 'B', values: { ang: { kind: 'angle', value: Math.PI / 2 }, k: { kind: 'distance', value: 2 } } },
    };
    const doc = new Drawing({ entities: [insert], blocks: { B: block } });
    const evaluation = evaluateDynamicBlock(def, [], [attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    // Stepwise ground truth: rotate (1e308, −1e308) → (1e308, 1e308);
    // scale ×2 about (9e307, 9e307) → (1.1e308, 1.1e308).
    const evaluated = evaluation.attributes[0]!;
    expect(evaluated.position.x / 1e308).toBeCloseTo(1.1, 9);
    expect(evaluated.position.y / 1e308).toBeCloseTo(1.1, 9);
    // Forward through the record: the naive form forms −2·(−1e308).
    const displayed = text(doc);
    expect(anchorsFinite(displayed)).toBe(true);
    expect(displayed.position.x / 1e308).toBeCloseTo(1.1, 9);
    expect(displayed.position.y / 1e308).toBeCloseTo(1.1, 9);
    expect(displayed.alignmentPoint!.x / 1e308).toBeCloseTo(1.3, 9);
    expect(displayed.color).toBe(1);
    // Inverse rebase of the evaluated placement returns the authored one.
    const rebased = importedPlacementsToAuthoredFrame(insert, block, { TAG: { ...evaluated, color: 1 } });
    expect(rebased.TAG).toBeDefined();
    expect(anchorsFinite(rebased.TAG!)).toBe(true);
    expect(rebased.TAG!.position.x / 1e308).toBeCloseTo(1, 9);
    expect(rebased.TAG!.position.y / 1e308).toBeCloseTo(-1, 9);
    expect(rebased.TAG!.color).toBe(1);
  });

  it('case 2: genuine placement far from every authored anchor (adversarial A) expands finitely and correctly', () => {
    const authored = packetFixture(1e308).attribute;
    for (const [qx, expectedRatio] of [[0, -1.2], [1e307, -1]] as const) {
      const { doc } = packetFixture(1e308, 4, { ...authored, position: { x: qx, y: 0 }, color: 1 });
      const displayed = text(doc);
      expect(anchorsFinite(displayed)).toBe(true);
      // Stepwise truth for the moved point: ×0.5 about the origin, then
      // ×4 about (4e307, 0): (0,0) → (−1.2e308, 0); 1e307 → −1e308.
      expect(displayed.position.x / 1e308).toBeCloseTo(expectedRatio, 9);
      expect(displayed.position.y).toBe(0);
      expect(displayed.color).toBe(1);
    }
  });

  it('case 3: inverse rebase of a saved placement on the opposite side of the anchor (adversarial D)', () => {
    const { def, block, insert } = packetFixture(1e308, 4);
    const evaluation = evaluateDynamicBlock(def, [], [packetFixture(1e308).attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    const evaluated = evaluation.attributes[0]!;
    // Saved placement far on the opposite side: rebasing subtracts
    // −1.7e308 − 8e307 before the 0.5 can shrink it. Exact result:
    // 0.5·(−1.7e308) + 6e307 = −2.5e307.
    const saved: Placement = { ...evaluated, position: { x: -1.7e308, y: 0 }, color: 1 };
    const rebased = importedPlacementsToAuthoredFrame(insert, block, { TAG: saved });
    expect(rebased.TAG).toBeDefined();
    expect(anchorsFinite(rebased.TAG!)).toBe(true);
    expect(rebased.TAG!.position.x / 1e308).toBeCloseTo(-0.25, 9);
    expect(rebased.TAG!.color).toBe(1);
    expect(saved.position.x).toBe(-1.7e308); // input not mutated
  });

  it('case 4: reflection record at large finite scale, forward and inverse', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 1e308, y: 9e307 },
      alignmentPoint: { x: 9.5e307, y: 1.05e308 },
      firstAlignmentPoint: { x: 1.05e308, y: 9.5e307 },
      height: 2, align: 'left', rotation: 0,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [
        { kind: 'flip', id: 'fl', name: 'fl', basePoint: { x: 0, y: 0 }, defaultValue: false },
        distance('k'),
      ],
      actions: [
        { kind: 'flip', id: 'FLP', name: 'FLP', parameterId: 'fl', axisA: { x: 0, y: 0 }, axisB: { x: 1, y: 1 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'SCL', name: 'SCL', parameterId: 'k', basePoint: { x: 6e307, y: 6e307 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attribute], dynamic: def };
    const insert: InsertEntity = {
      id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1,
      attributes: { TAG: 'USER-TAG' }, attributePlacements: { TAG: { ...attribute, color: 1 } },
      dynamic: { block: 'B', values: { fl: { kind: 'flip', value: true }, k: { kind: 'distance', value: 2 } } },
    };
    const doc = new Drawing({ entities: [insert], blocks: { B: block } });
    // Stepwise truth: flip across y = x swaps the position to
    // (9e307, 1e308); scale ×2 about (6e307, 6e307) → (1.2e308, 1.4e308).
    // The naive record application forms 2·9e307 = 1.8e308 = Infinity.
    const displayed = text(doc);
    expect(anchorsFinite(displayed)).toBe(true);
    expect(displayed.position.x / 1e308).toBeCloseTo(1.2, 9);
    expect(displayed.position.y / 1e308).toBeCloseTo(1.4, 9);
    expect(displayed.color).toBe(1);
    const evaluation = evaluateDynamicBlock(def, [], [attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    const rebased = importedPlacementsToAuthoredFrame(insert, block, { TAG: { ...evaluation.attributes[0]!, color: 1 } });
    expect(rebased.TAG).toBeDefined();
    expect(anchorsFinite(rebased.TAG!)).toBe(true);
    expect(rebased.TAG!.position.x / 1e308).toBeCloseTo(1, 9);
    expect(rebased.TAG!.position.y / 1e308).toBeCloseTo(0.9, 9);
  });

  it('case 4b: flip axis fixing every authored anchor — record-only motion still composes (R3-01 sub-case)', () => {
    const attribute: AttributeDef = {
      tag: 'TAG', prompt: 'TAG', default: 'DEFAULT',
      position: { x: 5e307, y: 5e307 },
      alignmentPoint: { x: 6e307, y: 6e307 },
      firstAlignmentPoint: { x: 4e307, y: 4e307 },
      height: 2, align: 'left', rotation: 0,
    };
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [{ kind: 'flip', id: 'fl', name: 'fl', basePoint: { x: 0, y: 0 }, defaultValue: false }],
      actions: [
        { kind: 'flip', id: 'FLP', name: 'FLP', parameterId: 'fl', axisA: { x: 0, y: 0 }, axisB: { x: 1, y: 1 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attribute], dynamic: def };
    const insert: InsertEntity = {
      id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1,
      attributes: { TAG: 'USER-TAG' },
      // Genuine placement OFF the axis: the authored definition is
      // field-identical after the flip, so only the recorded transform
      // can mirror this point.
      attributePlacements: { TAG: { ...attribute, position: { x: 5e307, y: 4e307 }, color: 1 } },
      dynamic: { block: 'B', values: { fl: { kind: 'flip', value: true } } },
    };
    const doc = new Drawing({ entities: [insert], blocks: { B: block } });
    const evaluation = evaluateDynamicBlock(def, [], [attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    // The evaluated definition matches the authored one to ulp level:
    // snapshot inference cannot distinguish this flip from identity.
    expect(evaluation.attributes[0]!.position.x / 5e307).toBeCloseTo(1, 9);
    expect(evaluation.attributes[0]!.position.y / 5e307).toBeCloseTo(1, 9);
    const displayed = text(doc);
    expect(displayed.position.x / 5e307).toBeCloseTo(0.8, 9);
    expect(displayed.position.y / 5e307).toBeCloseTo(1, 9);
    const rebased = importedPlacementsToAuthoredFrame(insert, block, {
      TAG: { ...attribute, position: { x: 4e307, y: 5e307 }, color: 1 },
    });
    expect(rebased.TAG!.position.x / 5e307).toBeCloseTo(1, 9);
    expect(rebased.TAG!.position.y / 5e307).toBeCloseTo(0.8, 9);
  });

  it('case 5: edit path with a genuine (non-restating) placement commits with finite displayed anchors', () => {
    const base = packetFixture(1e308);
    const { doc } = packetFixture(1e308, 1, { ...base.attribute, position: { x: 1e307, y: 0 }, color: 1 });
    const before = doc.snapshot;
    const revision = doc.revision;
    expect(anchorsFinite(text(doc))).toBe(true);
    const result = setDynamicParameter(before, 'top', 's2', 4);
    expect(result.problem).toBeUndefined();
    expect(result.state).not.toBe(before);
    doc.transact(() => result.state);
    expect(doc.revision).toBe(revision + 1);
    const displayed = text(doc);
    expect(anchorsFinite(displayed)).toBe(true);
    // Stepwise truth for the moved point: 1e307 → 5e306 → −1e308.
    expect(displayed.position.x / 1e308).toBeCloseTo(-1, 9);
    expect(displayed.color).toBe(1);
  });

  it('case 6: mid-scale exactness pin — the scaled path stays gated off ordinary values', () => {
    const unit = 1e150;
    const { def, insert, doc } = packetFixture(unit, 4);
    const evaluation = evaluateDynamicBlock(def, [], [packetFixture(unit).attribute], insert.dynamic);
    expect(evaluation.ok).toBe(true);
    if (!evaluation.ok) return;
    // The record is the plain composed one, anchored at the origin:
    // the probe found its plain application finite and left it alone.
    const bx = unit * 0.4;
    const expectedIx = bx + 4 * (0 - bx);
    const record = evaluation.attributeTransforms.get('TAG')!;
    expect(record).toEqual({
      a: 2, b: 0, c: 0, d: 2, ax: 0, ay: 0, ix: expectedIx, iy: 0, heightRatio: 2, rotationDelta: 0,
    });
    // Displayed anchors equal the plain anchored expression EXACTLY.
    const displayed = text(doc);
    expect(displayed.position.x).toBe(expectedIx + 2 * unit);
    expect(displayed.alignmentPoint!.x).toBe(expectedIx + 2 * (unit * 1.1));
    expect(displayed.firstAlignmentPoint!.x).toBe(expectedIx + 2 * (unit * 0.9));
    expect(displayed.height).toBe(4);
    // Ordinary unit-1000 control, exact integer arithmetic.
    const ordinary = packetFixture(1000, 4);
    const shown = text(ordinary.doc);
    expect(shown.position.x).toBe(800);
    expect(shown.alignmentPoint!.x).toBe(1000);
    expect(shown.firstAlignmentPoint!.x).toBe(600);
    expect(shown.height).toBe(4);
  });

  it('case 7: truly out-of-range placement — explicit refusal, never a stored/displayed Infinity, no edit commit', () => {
    // True image of (1.79e308, 0) under the packet pipeline is
    // 2.02e308 > max double: no arithmetic can represent it.
    const far: Placement = { ...packetFixture(1e308).attribute, position: { x: 1.79e308, y: 0 }, color: 1 };
    const forwardDoc = packetFixture(1e308, 4, far).doc;
    expect(() => text(forwardDoc)).toThrow(/refus|non.?finite|finite range/i);

    // Import side: an expanding inverse (scales ×0.5 then ×0.25) makes
    // the authored image of a saved 1.79e308 genuinely out of range.
    const shrinkDef: DynamicBlockDefinition = {
      version: 1, parameters: [distance('s1'), distance('s2')],
      actions: [
        { kind: 'scale', id: 'S1', name: 'S1', parameterId: 's1', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
        { kind: 'scale', id: 'S2', name: 'S2', parameterId: 's2', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
      ],
    };
    const shrinkAttr = packetFixture(1e308).attribute;
    const shrinkBlock: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [shrinkAttr], dynamic: shrinkDef };
    const shrinkInsert: InsertEntity = {
      id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1,
      attributes: { TAG: 'USER-TAG' },
      dynamic: { block: 'B', values: { s1: { kind: 'distance', value: 0.5 }, s2: { kind: 'distance', value: 0.25 } } },
    };
    const savedFar: Placement = { ...shrinkAttr, position: { x: 1.79e308, y: 0 }, height: 0.25, color: 1 };
    const placements = { TAG: savedFar };
    expect(() => importedPlacementsToAuthoredFrame(shrinkInsert, shrinkBlock, placements))
      .toThrow(/refus|non.?finite|finite range/i);
    expect(placements.TAG.position.x).toBe(1.79e308); // nothing stored, input untouched

    // Edit path: at s2 = 1 the far placement displays finitely
    // (×0.5 only); editing s2 → 4 must refuse BEFORE commit.
    const { doc } = packetFixture(1e308, 1, far);
    const before = doc.snapshot;
    const revision = doc.revision;
    expect(anchorsFinite(text(doc))).toBe(true);
    const result = setDynamicParameter(before, 'top', 's2', 4);
    expect(result.problem).toBe('degenerate-transform');
    expect(result.state).toBe(before);
    expect(doc.revision).toBe(revision);
  });
});
