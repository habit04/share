/**
 * Review round 3, R2-01 — the FULL dynamic transform must reach genuine
 * per-instance ATTRIB placement/appearance overrides.
 *
 * The defect: a stored placement is a complete authored-frame placement
 * (anchors + height + rotation + appearance). The R07 composition moved
 * it by the evaluation's position delta only, so when an instance
 * carried a genuine override (e.g. an imported ATTRIB whose only
 * deliberate difference is its colour), the scale and rotate parts of
 * the evaluated transform never reached the visible attribute: at a
 * fixed anchor the evaluated ATTDEF said height 4 / rotation
 * 0.25 + PI/2 while the rendered ATTRIB kept height 2 / rotation 0.25.
 *
 * The contract pinned here: a stored placement composes with the
 * evaluation transform as a placement — anchors ride the transform's
 * linear part about the definition anchors, height composes by the
 * transform's height ratio, rotation by its rotation delta, and
 * appearance (colour, layer, style) plus the fields evaluation never
 * transforms (width factor, oblique, justification) carry through
 * untouched. The import rebase is the exact inverse, so a genuine
 * override stored in the authored frame is a fixed point of
 * write/read/edit cycles.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { explodeInsert, type AttributeDef, type BlockDef, type InsertEntity, type TextEntity } from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { setDynamicParameter } from '../src/core/parametric/apply';
import { readDxf, writeDxf } from '../src/io/dxf';

const attribute = (): AttributeDef => ({ tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 0, y: 0 }, height: 2, align: 'left', rotation: 0.25 });

const instance = (): InsertEntity => ({ id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'CHILD',
  position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' },
  dynamic: { block: 'CHILD', values: {} },
  // Genuine appearance override: the imported ATTRIB keeps the entire
  // native placement; its only deliberate difference is the colour.
  attributePlacements: { TAG: { position: { x: 0, y: 0 }, height: 2, align: 'left', rotation: 0.25, color: 1 } } });

function drawing(kind: 'scale' | 'rotate'): Drawing {
  const dynamic: DynamicBlockDefinition = kind === 'scale' ? { version: 1,
    parameters: [{ kind: 'linear-distance', id: 'value', name: 'Scale', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 10, constraint: { kind: 'range', min: 1, max: 40 }, grips: [{ role: 'value', movesWithValue: true }] }],
    actions: [{ kind: 'scale', id: 'scale', name: 'Scale', parameterId: 'value', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] }] } : { version: 1,
    parameters: [{ kind: 'angle', id: 'value', name: 'Angle', basePoint: { x: 0, y: 0 }, defaultValue: 0, constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }] }],
    actions: [{ kind: 'rotate', id: 'rotate', name: 'Rotate', parameterId: 'value', center: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] }] };
  const block: BlockDef = { name: 'CHILD', basePoint: { x: 0, y: 0 }, entities: [], attributes: [attribute()], dynamic };
  return new Drawing({ entities: [instance()], blocks: { CHILD: block } });
}

const text = (doc: Drawing): TextEntity => {
  const found = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock)
    .find((e): e is TextEntity => e.type === 'text' && e.text === 'USER-TAG');
  if (!found) throw new Error('missing visible TAG');
  return found;
};

const edit = (doc: Drawing, value: number): Drawing => {
  const result = setDynamicParameter(doc.snapshot, (doc.entities[0] as InsertEntity).id, 'value', value);
  expect(result.problem).toBeUndefined();
  return new Drawing(result.state);
};

const reopened = (doc: Drawing): Drawing => new Drawing(readDxf(writeDxf(doc.snapshot)));

describe('R2-01 — full transform reaches a genuine colour-only placement override', () => {
  it('scale at a fixed anchor scales the visible height, direct and through DXF, across re-edits', () => {
    const original = drawing('scale');
    for (const input of [original, reopened(original)]) {
      const scaled = edit(input, 20);
      expect(text(scaled).position).toEqual({ x: 0, y: 0 });
      expect(text(scaled).color).toBe(1);
      expect(text(scaled).height).toBe(4);
      const again = edit(reopened(scaled), 30);
      expect(text(again).color).toBe(1);
      expect(text(again).height).toBe(6);
    }
  });

  it('rotate about a fixed anchor rotates the visible attribute, direct and through DXF, across re-edits', () => {
    const original = drawing('rotate');
    for (const input of [original, reopened(original)]) {
      const rotated = edit(input, Math.PI / 2);
      expect(text(rotated).position).toEqual({ x: 0, y: 0 });
      expect(text(rotated).color).toBe(1);
      expect(text(rotated).rotation).toBeCloseTo(0.25 + Math.PI / 2, 9);
      const again = edit(reopened(rotated), Math.PI);
      expect(text(again).color).toBe(1);
      expect(text(again).rotation).toBeCloseTo(0.25 + Math.PI, 9);
    }
  });

  it('the stored override is a fixed point: reopening an edited state restores the authored frame', () => {
    const scaled = edit(drawing('scale'), 20);
    const stored = (reopened(scaled).entities[0] as InsertEntity).attributePlacements?.TAG;
    // The file recorded the evaluated height (4) with the genuine colour;
    // the stored placement must be back at the authored height with the
    // colour intact — not stuck at the saved evaluated values. (Rotation
    // is asserted to 9 places: the DXF writer's 10-decimal formatting
    // and the insert-frame conversion bound its round-trip precision.)
    expect(stored?.height).toBe(2);
    expect(stored?.rotation).toBeCloseTo(0.25, 9);
    expect(stored?.color).toBe(1);
    const rotated = edit(drawing('rotate'), Math.PI / 2);
    const storedR = (reopened(rotated).entities[0] as InsertEntity).attributePlacements?.TAG;
    expect(storedR?.height).toBe(2);
    expect(storedR?.rotation).toBeCloseTo(0.25, 9);
    expect(storedR?.color).toBe(1);
  });
});

describe('R2-01 — genuine offsets ride the full transform, not just its translation', () => {
  const offsetInstance = (): InsertEntity => ({ ...instance(),
    attributePlacements: { TAG: { position: { x: 3, y: 1 }, height: 2, align: 'left', rotation: 0.25, color: 1 } } });
  const offsetDrawing = (kind: 'scale' | 'rotate'): Drawing => {
    const doc = drawing(kind);
    return new Drawing({ ...doc.snapshot, entities: [offsetInstance()] });
  };

  it('scale: an intentional offset from the authored anchor scales with the transform', () => {
    const scaled = edit(offsetDrawing('scale'), 20);
    expect(text(scaled).position).toEqual({ x: 6, y: 2 });
    expect(text(scaled).height).toBe(4);
    expect(text(scaled).color).toBe(1);
  });

  it('rotate: an intentional offset from the authored anchor rotates with the transform', () => {
    const rotated = edit(offsetDrawing('rotate'), Math.PI / 2);
    // Offset (3,1) from the centre rotates to (-1,3).
    expect(text(rotated).position.x).toBeCloseTo(-1, 9);
    expect(text(rotated).position.y).toBeCloseTo(3, 9);
    expect(text(rotated).rotation).toBeCloseTo(0.25 + Math.PI / 2, 9);
    expect(text(rotated).color).toBe(1);
  });
});

describe('R2-01 — flip composes as a reflection, including with rotation', () => {
  const flipAttr = (): AttributeDef => ({ tag: 'TAG', prompt: 'Tag', default: 'DEFAULT', position: { x: 6, y: 1 }, height: 2, align: 'left',
    rotation: 0.25, alignmentPoint: { x: 16, y: 1 }, firstAlignmentPoint: { x: 6, y: 6 } });
  const flipBlock = (withRotate: boolean): BlockDef => ({ name: 'CHILD', basePoint: { x: 0, y: 0 }, entities: [], attributes: [flipAttr()],
    dynamic: { version: 1,
      parameters: [
        { kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 5, y: 0 }, defaultValue: false },
        ...(withRotate ? [{ kind: 'angle', id: 'swing', name: 'Swing', basePoint: { x: 0, y: 0 }, defaultValue: 0, constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }] } as const] : []),
      ],
      actions: [
        { kind: 'flip', id: 'F1', name: 'Flip', parameterId: 'handed', axisA: { x: 5, y: 0 }, axisB: { x: 5, y: 1 }, selection: [{ entityId: 'TAG' }] },
        ...(withRotate ? [{ kind: 'rotate', id: 'R1', name: 'Rotate', parameterId: 'swing', center: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] } as const] : []),
      ] } });
  const flipInsert = (values: InsertEntity['dynamic']): InsertEntity => ({ id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'CHILD',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG: 'USER-TAG' }, dynamic: values,
    // Genuine override: anchors offset from the definition's, height 3
    // (1.5x the definition's 2), rotation 0.5, colour 1.
    attributePlacements: { TAG: { position: { x: 7, y: 1 }, height: 3, align: 'left', rotation: 0.5, color: 1,
      alignmentPoint: { x: 18, y: 1 }, firstAlignmentPoint: { x: 7, y: 8 } } } });

  it('flip: every placement anchor reflects across the axis; height/rotation offsets carry', () => {
    const doc = new Drawing({ entities: [flipInsert({ block: 'CHILD', values: { handed: { kind: 'flip', value: true } } })],
      blocks: { CHILD: flipBlock(false) } });
    const t = text(doc);
    // Definition anchors reflect across x=5 (position 6->4, AP 16->-6);
    // the placement's offsets (+1, +2 along x) reflect with them.
    expect(t.position).toEqual({ x: 3, y: 1 });
    expect(t.alignmentPoint).toEqual({ x: -8, y: 1 });
    expect(t.height).toBe(3);
    expect(t.rotation).toBe(0.5);
    expect(t.color).toBe(1);
  });

  it('flip then rotate: the composed linear part is the reflected rotation, not the scalar rotation', () => {
    const doc = new Drawing({ entities: [flipInsert({ block: 'CHILD', values: {
      handed: { kind: 'flip', value: true }, swing: { kind: 'angle', value: Math.PI / 2 } } })],
      blocks: { CHILD: flipBlock(true) } });
    const t = text(doc);
    // Evaluated definition position: (6,1) -flip-> (4,1) -rotate90-> (-1,4).
    // The placement's +1 x-offset rides R(90) * reflect: (1,0) -> (0,-1).
    expect(t.position.x).toBeCloseTo(-1, 9);
    expect(t.position.y).toBeCloseTo(3, 9);
    expect(t.height).toBe(3);
    expect(t.rotation).toBeCloseTo(0.5 + Math.PI / 2, 9);
    expect(t.color).toBe(1);
  });
});
