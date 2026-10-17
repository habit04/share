/**
 * Review round 5, R4-01 — the RECORDED attribute transform must stay
 * finite, and its inverse must stay computable, for every transform
 * whose actual application is finite.
 *
 * The defects (both in the round-4 record's ABSOLUTE affine form):
 * (a) a rotate by π about a centre at (1e308, 0) records the offset
 *     c − R·c = 2·1e308 = Infinity, so a genuine COLOUR-ONLY override
 *     of an attribute sitting exactly on the centre displayed
 *     nonfinite geometry even though the evaluator's centre-relative
 *     application correctly left the point fixed and finite;
 * (b) flip then scale 1e160 applies, displays and writes DXF fine,
 *     but the import-side inverse formed det = −(1e160)² = −Infinity,
 *     treated it as singular, and JCad's own readDxf of its own output
 *     threw.
 *
 * The contract pinned here: the record is ANCHORED (each action
 * records a point it fixes exactly as its anchor, and that point's
 * image), composition and application only ever multiply relative
 * vectors, and inversion normalizes the linear part by magnitude
 * before forming the determinant — so representable transforms keep
 * finite forward AND inverse maps, and stored overrides stay a
 * write/read fixed point at any representable scale. No refusal is
 * introduced for these cases: the original repros expect SUCCESS.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import { explodeInsert, type AttributeDef, type BlockDef, type InsertEntity, type TextEntity } from '../src/core/entities';
import { validateDefinition, type DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import { setDynamicParameter } from '../src/core/parametric/apply';
import type { DynamicInstanceState } from '../src/core/parametric/instance';
import { readDxf, writeDxf } from '../src/io/dxf';

const attr = (tag = 'TAG', x = 0, y = 0): AttributeDef => ({ tag, prompt: tag, default: 'DEFAULT', position: { x, y }, height: 2, align: 'left', rotation: 0.25 });
const flipParam = (id: string) => ({ kind: 'flip', id, name: id, basePoint: { x: 0, y: 0 }, defaultValue: false } as const);
const angleParam = { kind: 'angle', id: 'angle', name: 'Angle', basePoint: { x: 0, y: 0 }, defaultValue: 0,
  constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }] } as const;
const distanceParam = { kind: 'linear-distance', id: 'size', name: 'Size', basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 }, defaultValue: 1,
  constraint: { kind: 'unbounded' }, grips: [{ role: 'value', movesWithValue: false }] } as const;

function drawing(def: DynamicBlockDefinition, values: DynamicInstanceState['values'], attrs: readonly AttributeDef[] = [attr()],
  placements?: InsertEntity['attributePlacements']): Drawing {
  const block: BlockDef = { name: 'B', basePoint: { x: 0, y: 0 }, entities: [], attributes: attrs, dynamic: def };
  const ins: InsertEntity = { id: 'top', type: 'insert', layer: '0', color: 'ByLayer', block: 'B', position: { x: 0, y: 0 }, rotation: 0, scale: 1,
    attributes: Object.fromEntries(attrs.map((a) => [a.tag, `USER-${a.tag}`])), dynamic: { block: 'B', values },
    attributePlacements: placements ?? Object.fromEntries(attrs.map((a) => [a.tag, { ...a, position: { x: a.position.x + 2, y: 1 }, height: 3, rotation: 0.5, color: 1 }])) };
  return new Drawing({ entities: [ins], blocks: { B: block } });
}
function text(doc: Drawing, tag = 'TAG'): TextEntity {
  const item = explodeInsert(doc.entities[0] as InsertEntity, doc.lookupBlock).find((e): e is TextEntity => e.type === 'text' && e.text === `USER-${tag}`);
  if (!item) throw new Error('Missing visible ' + tag);
  return item;
}
function point(actual: { x: number; y: number }, x: number, y: number): void {
  expect(actual.x).toBeCloseTo(x, 9);
  expect(actual.y).toBeCloseTo(y, 9);
}

describe('R4-01 finite recorded transforms (round 5)', () => {
  it('keeps a colour-only override finite under a π rotation about a huge finite centre', () => {
    const def: DynamicBlockDefinition = { version: 1, parameters: [angleParam], actions: [
      { kind: 'rotate', id: 'R', name: 'R', parameterId: 'angle', center: { x: 1e308, y: 0 }, selection: [{ entityId: 'TAG' }] },
    ] };
    const a = attr('TAG', 1e308);
    const doc = drawing(def, { angle: { kind: 'angle', value: Math.PI } }, [a], { TAG: { ...a, color: 1 } });
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    const evaluated = evaluateDynamicBlock(def, [], [a], (doc.entities[0] as InsertEntity).dynamic);
    expect(evaluated.ok).toBe(true);
    if (!evaluated.ok) return;
    expect(evaluated.attributes[0]!.position).toEqual({ x: 1e308, y: 0 });
    // The override differs from the authored attribute ONLY in colour,
    // so it restates the authored anchor: the anchored record must map
    // it to the centre exactly, not to absolute-offset infinity.
    const displayed = text(doc);
    expect(Number.isFinite(displayed.position.x) && Number.isFinite(displayed.position.y)).toBe(true);
    expect(displayed.position).toEqual({ x: 1e308, y: 0 });
    expect(displayed.color).toBe(1);
    expect(displayed.rotation).toBeCloseTo(0.25 + Math.PI, 9);
  });

  it('reopens a flip-and-scale 1e160 placement as a fixed point (inverse determinant stays representable)', () => {
    const def: DynamicBlockDefinition = { version: 1, parameters: [flipParam('f'), distanceParam], actions: [
      { kind: 'flip', id: 'F', name: 'F', parameterId: 'f', axisA: { x: 0, y: 0 }, axisB: { x: 1, y: 0 }, selection: [{ entityId: 'TAG' }] },
      { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
    ] };
    const doc = drawing(def, { f: { kind: 'flip', value: true }, size: { kind: 'distance', value: 1e160 } });
    expect(validateDefinition(def, new Set(['TAG']))).toEqual([]);
    const displayed = text(doc);
    expect(Number.isFinite(displayed.position.x) && Number.isFinite(displayed.position.y) && Number.isFinite(displayed.height)).toBe(true);
    expect(displayed.position.x / 1e160).toBeCloseTo(2, 9);
    expect(displayed.position.y / 1e160).toBeCloseTo(-1, 9);
    const dxf = writeDxf(doc.snapshot);
    expect(() => readDxf(dxf)).not.toThrow();
    const saved = new Drawing(readDxf(dxf));
    point((saved.entities[0] as InsertEntity).attributePlacements!.TAG!.position, 2, 1);
    expect((saved.entities[0] as InsertEntity).attributePlacements!.TAG!.height).toBeCloseTo(3, 9);
    // And the reopened state displays the same evaluated placement:
    // the stored override is a write/read fixed point at this scale.
    const redisplayed = text(saved);
    expect(redisplayed.position.x / 1e160).toBeCloseTo(2, 9);
    expect(redisplayed.position.y / 1e160).toBeCloseTo(-1, 9);
  });

  it('reopens a scale-only 1e160 placement (no flip) as a fixed point', () => {
    const def: DynamicBlockDefinition = { version: 1, parameters: [distanceParam], actions: [
      { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'TAG' }] },
    ] };
    const doc = drawing(def, { size: { kind: 'distance', value: 1e160 } });
    const displayed = text(doc);
    expect(displayed.position.x / 1e160).toBeCloseTo(2, 9);
    expect(displayed.position.y / 1e160).toBeCloseTo(1, 9);
    const dxf = writeDxf(doc.snapshot);
    expect(() => readDxf(dxf)).not.toThrow();
    const saved = new Drawing(readDxf(dxf));
    point((saved.entities[0] as InsertEntity).attributePlacements!.TAG!.position, 2, 1);
    expect((saved.entities[0] as InsertEntity).attributePlacements!.TAG!.height).toBeCloseTo(3, 9);
  });

  it('keeps an off-centre override finite under a π rotation about a huge centre', () => {
    const def: DynamicBlockDefinition = { version: 1, parameters: [angleParam], actions: [
      { kind: 'rotate', id: 'R', name: 'R', parameterId: 'angle', center: { x: 1e308, y: 0 }, selection: [{ entityId: 'TAG' }] },
    ] };
    // Authored attribute at (5e307, 0): its π image about the centre is
    // (1.5e308, 0) — representable, so the transform must succeed.
    const a = attr('TAG', 5e307);
    const doc = drawing(def, { angle: { kind: 'angle', value: Math.PI } }, [a],
      { TAG: { ...a, position: { x: 5e307, y: 3 }, color: 1 } });
    const displayed = text(doc);
    expect(Number.isFinite(displayed.position.x) && Number.isFinite(displayed.position.y)).toBe(true);
    expect(displayed.position.x / 1e308).toBeCloseTo(1.5, 9);
    // The y component rides the evaluator's own cos/sin rotation of a
    // 5e307 lever arm: sin(π)·5e307 ≈ 6.2e291 of residue (relative
    // 1.2e-16 — float dust inherent to rotating about a huge centre,
    // identical in the evaluator's relative application), not the
    // absolute-offset overflow this round fixes.
    expect(Math.abs(displayed.position.y) / 5e307).toBeLessThan(1e-15);
    // Editing the parameter back to its default restores the authored
    // frame exactly — the anchored record inverts cleanly.
    const result = setDynamicParameter(doc.snapshot, doc.entities[0]!.id, 'angle', 0);
    expect(result.problem).toBeUndefined();
    const restored = text(new Drawing(result.state));
    expect(restored.position.x / 1e307).toBeCloseTo(5, 9);
    expect(restored.position.y).toBeCloseTo(3, 9);
  });

  it('reopens a flip-and-scale 1e160 placement whose scale base point is not the origin', () => {
    const def: DynamicBlockDefinition = { version: 1, parameters: [flipParam('f'), distanceParam], actions: [
      { kind: 'flip', id: 'F', name: 'F', parameterId: 'f', axisA: { x: 0, y: 0 }, axisB: { x: 1, y: 0 }, selection: [{ entityId: 'TAG' }] },
      { kind: 'scale', id: 'S', name: 'S', parameterId: 'size', basePoint: { x: 3, y: -2 }, selection: [{ entityId: 'TAG' }] },
    ] };
    const doc = drawing(def, { f: { kind: 'flip', value: true }, size: { kind: 'distance', value: 1e160 } });
    const displayed = text(doc);
    expect(Number.isFinite(displayed.position.x) && Number.isFinite(displayed.position.y) && Number.isFinite(displayed.height)).toBe(true);
    // Flip (2,1) -> (2,-1); scale 1e160 about (3,-2): (3,-2) + 1e160·(-1,1).
    expect(displayed.position.x / 1e160).toBeCloseTo(-1, 9);
    expect(displayed.position.y / 1e160).toBeCloseTo(1, 9);
    const dxf = writeDxf(doc.snapshot);
    expect(() => readDxf(dxf)).not.toThrow();
    const saved = new Drawing(readDxf(dxf));
    point((saved.entities[0] as InsertEntity).attributePlacements!.TAG!.position, 2, 1);
    expect((saved.entities[0] as InsertEntity).attributePlacements!.TAG!.height).toBeCloseTo(3, 9);
  });
});
