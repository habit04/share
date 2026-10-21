/**
 * Review round 4, R3-01 — a FLIP must compose with genuine per-instance
 * ATTRIB placement overrides even when the flip's axis fixes every
 * authored anchor.
 *
 * The defect: round 3 recovered the evaluation transform by INFERRING
 * it from the authored/effective ATTDEF snapshots. A reflection and
 * the identity can fix the same anchors, so when the authored anchors
 * all lie on the flip axis (left, right, center and FIT placements
 * alike), the evaluated definition is field-identical to the authored
 * one, the inference saw "nothing moved", and a genuine override was
 * left unreflected: an override at (2, 1) stayed at (2, 1) instead of
 * moving to (2, -1). No snapshot-based inference can recover that
 * axis, and the round-3 single-anchor translation approximation is
 * rejected for the same reason.
 *
 * The contract pinned here: composition consumes the transform the
 * evaluation actually RECORDED while its action pipeline ran (and, on
 * import, that record's exact inverse) — never a snapshot guess — so
 * the flip reflects every anchor of a genuine override exactly, the
 * stored override stays a write/read/edit fixed point, and when no
 * record exists while a flip may be active, composition REFUSES
 * explicitly (throws) instead of reporting success with wrong
 * geometry.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import {
  attributePlacementsForDef, explodeInsert,
  type AttributeDef, type BlockDef, type InsertEntity, type TextEntity,
} from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { readDxf, writeDxf } from '../src/io/dxf';

const flipParameter = { kind: 'flip', id: 'value', name: 'Flip', basePoint: { x: 0, y: 0 }, defaultValue: false } as const;
const flipAction = { kind: 'flip', id: 'F', name: 'Flip', parameterId: 'value', axisA: { x: 0, y: 0 }, axisB: { x: 1, y: 0 }, selection: [{ entityId: 'TAG' }] } as const;

/** Codex's tiny example: ATTDEF on the axis at (0,0), height 2,
 *  rotation 0.25; genuine override (2,1), height 3, rotation 0.5,
 *  colour 1, width factor 1.2, oblique 0.1. */
function tinyDrawing(): Drawing {
  const attr: AttributeDef = { tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 0, y: 0 }, height: 2, rotation: 0.25, align: 'left' };
  const dynamic: DynamicBlockDefinition = { version: 1, parameters: [flipParameter], actions: [flipAction] };
  const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attr], dynamic };
  const ins: InsertEntity = { id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
    dynamic: { block: 'B', values: {} },
    attributePlacements: { TAG: { ...attr, position: { x: 2, y: 1 }, height: 3, rotation: 0.5, color: 1, widthFactor: 1.2, oblique: 0.1 } } };
  return new Drawing({ entities: [ins], blocks: { B: block } });
}

const reopen = (doc: Drawing): Drawing => new Drawing(readDxf(writeDxf(doc.snapshot)));

function edit(doc: Drawing, value: number | boolean, id = 'value'): Drawing {
  const result = setDynamicParameter(doc.snapshot, doc.entities[0]!.id, id, value);
  expect(result.problem).toBeUndefined();
  return new Drawing(result.state);
}

function tag(doc: Drawing): TextEntity {
  const found = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
    .find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
  if (!found) throw new Error('Visible USER-TAG missing');
  return found;
}

describe('R3-01 — flip on an anchor-fixing axis still reflects a genuine override', () => {
  it('tiny example, direct: (2,1) reflects to (2,-1); size/angle/appearance/shape carry', () => {
    const flipped = edit(tinyDrawing(), true);
    const t = tag(flipped);
    expect(t.position).toEqual({ x: 2, y: -1 });
    expect(t.height).toBe(3);
    expect(t.rotation).toBe(0.5);
    expect(t.color).toBe(1);
    expect(t.widthFactor).toBeCloseTo(1.2, 9);
    expect(t.oblique).toBeCloseTo(0.1, 9);
    expect(t.text).toBe('USER-TAG');
  });

  it('tiny example through DXF: the stored override is a fixed point across save/reopen/edit cycles', () => {
    const flipped = edit(tinyDrawing(), true);
    const saved = reopen(flipped);
    expect(tag(saved).position).toEqual({ x: 2, y: -1 });
    // The rebase inverted the recorded reflection exactly: the stored
    // placement is the authored override again, not the evaluated one.
    // (Height/rotation are asserted to 9 places: the DXF writer's
    // 10-decimal formatting and the insert-frame conversion bound the
    // round-trip precision at ~1e-15 relative — the same noise class
    // the round-3 fixed-point test documented. Position is exact.)
    const stored = (saved.entities[0] as InsertEntity).attributePlacements?.TAG;
    expect(stored?.position).toEqual({ x: 2, y: 1 });
    expect(stored?.height).toBeCloseTo(3, 9);
    expect(stored?.rotation).toBeCloseTo(0.5, 9);
    expect(stored?.color).toBe(1);
    const restored = edit(saved, false);
    expect(tag(restored).position).toEqual({ x: 2, y: 1 });
    const again = edit(reopen(restored), true);
    expect(tag(again).position).toEqual({ x: 2, y: -1 });
    expect(tag(again).height).toBeCloseTo(3, 9);
    expect(tag(again).color).toBe(1);
  });

  it('right-justified: ALL anchors lie on the axis, and every one reflects', () => {
    const attr: AttributeDef = { tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 0, y: 0 }, height: 2, rotation: 0.25,
      align: 'right', justification: { horizontal: 2, vertical: 0 }, alignmentPoint: { x: 0, y: 0 }, firstAlignmentPoint: { x: -3, y: 0 } };
    const dynamic: DynamicBlockDefinition = { version: 1, parameters: [flipParameter], actions: [flipAction] };
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attr], dynamic };
    const ins: InsertEntity = { id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
      dynamic: { block: 'B', values: {} },
      attributePlacements: { TAG: { ...attr, position: { x: 2, y: 1 }, alignmentPoint: { x: 2, y: 1 }, firstAlignmentPoint: { x: -1, y: 1 },
        height: 3, rotation: 0.5, color: 1 } } };
    const doc = new Drawing({ entities: [ins], blocks: { B: block } });
    for (const input of [doc, reopen(doc)]) {
      const t = tag(edit(input, true));
      expect(t.position).toEqual({ x: 2, y: -1 });
      expect(t.alignmentPoint).toEqual({ x: 2, y: -1 });
      expect(t.firstAlignmentPoint).toEqual({ x: -1, y: -1 });
      // Height to 9 places: the justified-text rendering path carries
      // ~1e-15 relative float dust (pre-existing; the acceptance matrix
      // asserts the same tolerance).
      expect(t.height).toBeCloseTo(3, 9);
      expect(t.color).toBe(1);
    }
  });

  it('fit: both anchors on the axis reflect, direct and reopened', () => {
    const attr: AttributeDef = { tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 0, y: 0 }, height: 2, rotation: 0.25,
      align: 'left', justification: { horizontal: 5, vertical: 0 }, alignmentPoint: { x: 4, y: 0 } };
    const dynamic: DynamicBlockDefinition = { version: 1, parameters: [flipParameter], actions: [flipAction] };
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attr], dynamic };
    const ins: InsertEntity = { id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
      dynamic: { block: 'B', values: {} },
      attributePlacements: { TAG: { ...attr, position: { x: 2, y: 1 }, alignmentPoint: { x: 6, y: 1 }, height: 3, rotation: 0.5, color: 1 } } };
    const doc = new Drawing({ entities: [ins], blocks: { B: block } });
    for (const input of [doc, reopen(doc)]) {
      const t = tag(edit(input, true));
      expect(t.position).toEqual({ x: 2, y: -1 });
      expect(t.alignmentPoint).toEqual({ x: 6, y: -1 });
      expect(t.height).toBe(3);
      expect(t.color).toBe(1);
    }
  });

  it('flip composes with a scale in the same evaluation (record composition, pipeline order)', () => {
    const attr: AttributeDef = { tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 0, y: 0 }, height: 2, rotation: 0.25, align: 'left' };
    const dynamic: DynamicBlockDefinition = { version: 1,
      parameters: [flipParameter,
        { kind: 'linear-distance', id: 'dist', name: 'Dist', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10,
          constraint: { kind: 'range', min: 1, max: 40 }, grips: [{ role: 'value', movesWithValue: true }] }],
      actions: [flipAction,
        { kind: 'scale', id: 'S', name: 'Scale', parameterId: 'dist', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] }] };
    const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attr], dynamic };
    const ins: InsertEntity = { id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
      position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
      dynamic: { block: 'B', values: {} },
      attributePlacements: { TAG: { ...attr, position: { x: 2, y: 1 }, height: 3, rotation: 0.5, color: 1 } } };
    const doc = new Drawing({ entities: [ins], blocks: { B: block } });
    const both = edit(edit(doc, true), 20, 'dist');
    const t = tag(both);
    // Flip reflects (2,1) -> (2,-1); scale 2 about the origin -> (4,-2), height 3 -> 6.
    expect(t.position).toEqual({ x: 4, y: -2 });
    expect(t.height).toBe(6);
    expect(t.rotation).toBe(0.5);
    expect(t.color).toBe(1);
  });
});

describe('R3-01 — no record + a possibly-active flip refuses explicitly', () => {
  it('attributePlacementsForDef throws for a foreign-derived definition while a flip is live, and not at the default state', () => {
    const doc = tinyDrawing();
    const authored = doc.blocks.B!;
    const ins = doc.entities[0] as InsertEntity;
    // A definition a caller derived elsewhere: same fields, but NOT the
    // object expansionBlock produced, so it carries no recorded
    // transform. With the flip live, the snapshots (identical here)
    // cannot prove the transform — composition must refuse, atomically.
    const foreign: BlockDef = { ...authored };
    const flippedIns: InsertEntity = { ...ins, dynamic: { block: 'B', values: { value: { kind: 'flip', value: true } } } };
    expect(() => attributePlacementsForDef(flippedIns, authored, foreign)).toThrow(/Refusing to compose the placement override for attribute 'TAG'/);
    // At the default state no flip can be active: the fallback inference
    // sees identical snapshots, moves nothing, and returns the insert
    // by identity — no refusal, no change.
    expect(attributePlacementsForDef(ins, authored, foreign)).toBe(ins);
  });
});
