/**
 * Review round 2, C06 — the R06 dry run must not accept nonfinite
 * evaluated geometry. Finite inputs can overflow in DERIVATION (a finite
 * distance times a finite stretch multiplier; a finite scale factor on a
 * large authored coordinate; a finite move delta added to a huge authored
 * coordinate; an array copy offset landing past the finite range), and
 * checking the input factor alone cannot see it. The evaluator now
 * validates every derived output entity and attribute placement for
 * finiteness before returning success, refusing 'degenerate-transform'
 * — so the setter's dry run refuses the edit atomically. Huge-but-finite
 * results still succeed: the test is Number.isFinite, not a magnitude cap.
 */
import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { AttributeDef, Entity, InsertEntity, LineEntity } from '../src/core/entities';
import type { BlockDef } from '../src/core/entities';
import { setDynamicParameter } from '../src/core/parametric/apply';
import type { DynamicBlockDefinition, LinearDistanceParameter } from '../src/core/parametric/definitions';
import { evaluateDynamicBlock } from '../src/core/parametric/evaluate';
import type { DynamicInstanceState } from '../src/core/parametric/instance';

const widthParam = (over: Partial<LinearDistanceParameter> = {}): LinearDistanceParameter => ({
  kind: 'linear-distance',
  id: 'width',
  name: 'Width',
  basePoint: { x: 0, y: 0 },
  direction: { x: 1, y: 0 },
  defaultValue: 10,
  constraint: { kind: 'unbounded' },
  grips: [{ role: 'value', movesWithValue: true }],
  ...over,
});

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});
const tagAttr = (): AttributeDef => ({ tag: 'TAG', prompt: 'Tag', default: 'D', position: { x: 6, y: 1 }, height: 1, align: 'left' });
const instance = (value: number): DynamicInstanceState => ({ block: 'B', values: { width: { kind: 'distance', value } } });

const stretchDef = (over: Partial<Extract<DynamicBlockDefinition['actions'][number], { kind: 'stretch' }>> = {}): DynamicBlockDefinition => ({
  version: 1,
  parameters: [widthParam()],
  actions: [{
    kind: 'stretch', id: 'stretch', name: 'Stretch', parameterId: 'width',
    frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [{ entityId: 'line', points: { kind: 'frame' } }],
    ...over,
  }],
});

describe('C06: derived nonfinite geometry refuses evaluation', () => {
  it('stretch: finite distance x finite multiplier overflows the derived endpoint', () => {
    const def = stretchDef({ distanceMultiplier: 1e308 });
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 10, 0)], [], instance(1e308));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('degenerate-transform');
      expect(result.refusal.message).toContain('line');
    }
  });

  it('stretch: an overflowing delta rotated off-axis derives NaN, also refused', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [widthParam({ direction: { x: 1, y: 1 } })],
      actions: [{
        kind: 'stretch', id: 'stretch', name: 'Stretch', parameterId: 'width', distanceMultiplier: 1e308, angleOffset: Math.PI / 4,
        frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 15 } },
        selection: [{ entityId: 'line', points: { kind: 'frame' } }],
      }],
    };
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 10, 10)], [], instance(1e308));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('degenerate-transform');
  });

  it('scale: a finite factor whose transformed endpoint overflows refuses (the factor itself is finite)', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [widthParam({ defaultValue: 1 })],
      actions: [{ kind: 'scale', id: 'scale', name: 'Scale', parameterId: 'width', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'line' }] }],
    };
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 10, 0)], [], instance(1e308));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('degenerate-transform');
  });

  it('move: a finite delta added to a huge authored coordinate overflows in derivation', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [widthParam()],
      actions: [{ kind: 'move', id: 'move', name: 'Move', parameterId: 'width', selection: [{ entityId: 'line' }] }],
    };
    const huge = line('line', 1.7e308, 0, 1.7e308, 5);
    const result = evaluateDynamicBlock(def, [huge], [], instance(1e308));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('degenerate-transform');
  });

  it('array: a copy whose offset lands past the finite range refuses', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [widthParam()],
      actions: [{ kind: 'array', id: 'array', name: 'Array', parameterId: 'width', spacing: 1e308, selection: [{ entityId: 'line' }] }],
    };
    // count(1.5e308) = floor(1.5) + 1 = 2 copies; copy 1 sits at +1e308 from x=1e308.
    const result = evaluateDynamicBlock(def, [line('line', 1e308, 0, 1e308, 1)], [], instance(1.5e308));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('degenerate-transform');
  });

  it('attribute placement: a stretch moving only the attribute derives a nonfinite position and refuses', () => {
    const def = stretchDef({ distanceMultiplier: 1e308, selection: [{ entityId: 'TAG', points: { kind: 'frame' } }] });
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 10, 0)], [tagAttr()], instance(1e308));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('degenerate-transform');
      expect(result.refusal.message).toContain('TAG');
    }
  });

  it('an untouched authored entity beside a derived one keeps its identity in a successful evaluation', () => {
    const bystander = line('other', 0, 20, 5, 20);
    const def = stretchDef();
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 10, 0), bystander], [], instance(14));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entities[1]).toBe(bystander);
  });
});

describe('C06: the R06 dry run refuses overflowing edits atomically', () => {
  const blockOf = (dynamic: DynamicBlockDefinition): BlockDef => ({
    name: 'B', basePoint: { x: 0, y: 0 }, entities: [line('line', 0, 0, 10, 0)], attributes: [], dynamic,
  });
  const insertOf = (): InsertEntity => ({
    id: 'A', type: 'insert', layer: '0', color: 'ByLayer', block: 'B',
    position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: {}, dynamic: { block: 'B', values: {} },
  });

  it('stretch overflow: problem is degenerate-transform and the state is the identical object', () => {
    const doc = new Drawing({ entities: [insertOf()], blocks: { B: blockOf(stretchDef({ distanceMultiplier: 1e308 })) } });
    const r = setDynamicParameter(doc.snapshot, 'A', 'width', 1e308);
    expect(r.problem).toBe('degenerate-transform');
    expect(r.state).toBe(doc.snapshot);
  });

  it('scale overflow: problem is degenerate-transform and the state is the identical object', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [widthParam({ defaultValue: 1 })],
      actions: [{ kind: 'scale', id: 'scale', name: 'Scale', parameterId: 'width', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'line' }] }],
    };
    const doc = new Drawing({ entities: [insertOf()], blocks: { B: blockOf(def) } });
    const r = setDynamicParameter(doc.snapshot, 'A', 'width', 1e308);
    expect(r.problem).toBe('degenerate-transform');
    expect(r.state).toBe(doc.snapshot);
  });

  it('through a Drawing, the refused overflow edit leaves snapshot, revision, dirty and undo untouched', () => {
    const doc = new Drawing({ entities: [insertOf()], blocks: { B: blockOf(stretchDef({ distanceMultiplier: 1e308 })) } });
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    expect(doc.dirty).toBe(false);
    doc.transact((s) => setDynamicParameter(s, 'A', 'width', 1e308).state);
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
    expect((doc.entities[0] as InsertEntity).dynamic?.values.width).toBeUndefined();
  });
});

describe('C06: huge-but-finite derivations still succeed (finiteness, not a magnitude cap)', () => {
  it('stretch to exactly 1e308 with a unit multiplier succeeds', () => {
    const def = stretchDef();
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 10, 0)], [], instance(1e308));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const out = result.entities[0] as LineEntity;
      expect(out.b.x).toBe(1e308);
      expect(Number.isFinite(out.b.x)).toBe(true);
    }
  });

  it('scale factor 1e308 on unit geometry succeeds (endpoint and radius land at 1e308)', () => {
    const def: DynamicBlockDefinition = {
      version: 1,
      parameters: [widthParam({ defaultValue: 1 })],
      actions: [{ kind: 'scale', id: 'scale', name: 'Scale', parameterId: 'width', basePoint: { x: 0, y: 0 }, selection: [{ entityId: 'line' }, { entityId: 'disc' }] }],
    };
    const disc: Entity = { id: 'disc', layer: '0', color: 'ByLayer', type: 'circle', center: { x: 0, y: 0 }, radius: 1 };
    const result = evaluateDynamicBlock(def, [line('line', 0, 0, 1, 0), disc], [], instance(1e308));
    expect(result.ok).toBe(true);
    if (result.ok) {
      const outLine = result.entities[0] as LineEntity;
      expect(outLine.b.x).toBe(1e308);
      const outDisc = result.entities[1]!;
      if (outDisc.type !== 'circle') throw new Error('unexpected output type');
      expect(outDisc.radius).toBe(1e308);
    }
  });
});
