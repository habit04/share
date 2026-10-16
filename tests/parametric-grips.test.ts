/**
 * Priority 30.4 slice B — dynamic-block grips: indices, world placement,
 * and drag-to-value through the same setDynamicParameter path as every
 * other parameter edit (core/parametric/grips.ts + entities gripPoints).
 *
 * Grip indices are positional: index 0 is the insert position grip and
 * dynamic parameter grips are appended after it in definition order.
 * Authored normalized model; NOT native AutoCAD evidence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import { gripPoints, moveGrip, type BlockDef, type InsertEntity, type LineEntity } from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { ANGLE_GRIP_RADIUS, dynamicGripDescriptor, dynamicGripEdit, dynamicGrips } from '../src/core/parametric/grips';

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

// Block GRIPBLK: width (linear, default 10, range [5,20]) + swing (angle,
// default 0, range [-90deg, 90deg]) + flip + visibility + lookup — only the
// distance and angle parameters may produce positional grips.
const definition = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [
    {
      kind: 'linear-distance', id: 'width', name: 'Width',
      basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
      defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
      grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
    },
    {
      kind: 'angle', id: 'swing', name: 'Swing',
      basePoint: { x: 0, y: 0 }, defaultValue: 0,
      constraint: { kind: 'range', min: -Math.PI / 2, max: Math.PI / 2 },
      grips: [{ role: 'value', movesWithValue: true }],
    },
    { kind: 'flip', id: 'handed', name: 'Handed', basePoint: { x: 0, y: 0 }, defaultValue: false },
    {
      kind: 'visibility', id: 'vis', name: 'Visibility', basePoint: { x: 0, y: 6 }, defaultState: 'All',
      states: [{ name: 'All', visible: ['L1'] }],
    },
    {
      kind: 'lookup', id: 'preset', name: 'Preset', basePoint: { x: 0, y: 7 },
      inputs: ['width'], defaultRow: null,
      rows: [{ name: 'Wide', key: { width: { kind: 'distance', value: 18 } }, assignments: {} }],
    },
  ],
  actions: [{
    kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
    frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [{ entityId: 'L1', points: { kind: 'frame' } }],
  }],
});

const dynBlock = (over: Partial<BlockDef> = {}): BlockDef => ({
  name: 'GRIPBLK',
  basePoint: { x: 0, y: 0 },
  entities: [line('L1', 0, 0, 10, 0)],
  attributes: [],
  dynamic: definition(),
  ...over,
});

const insert = (over: Partial<InsertEntity> = {}): InsertEntity => ({
  id: 'A', layer: '0', color: 'ByLayer', type: 'insert', block: 'GRIPBLK',
  position: { x: 100, y: 100 }, rotation: 0, scale: 1,
  attributes: {},
  dynamic: { block: 'GRIPBLK', values: { width: { kind: 'distance', value: 14 }, swing: { kind: 'angle', value: Math.PI / 6 } } },
  ...over,
});

const lookupOf = (block: BlockDef) => (n: string) => (n === block.name ? block : undefined);
const closeTo = (a: number, b: number) => expect(a).toBeCloseTo(b, 9);

describe('gripPoints — dynamic grips appended after the position grip', () => {
  it('index 0 stays the position grip; dynamic and static inserts agree there', () => {
    const block = dynBlock();
    const dyn = insert();
    const statik = insert({ block: 'PLAIN', dynamic: undefined });
    const plain = dynBlock({ name: 'PLAIN', dynamic: undefined });
    const lookup = (n: string) => (n === 'GRIPBLK' ? block : n === 'PLAIN' ? plain : undefined);
    expect(gripPoints(dyn, undefined, lookup)[0]).toEqual(dyn.position);
    expect(gripPoints(statik, undefined, lookup)).toEqual([statik.position]);
    // Without a lookup nothing changes at all (pre-30.4 behaviour).
    expect(gripPoints(dyn)).toEqual([dyn.position]);
  });

  it('appends exactly the distance and angle value grips, in definition order — none for flip/visibility/lookup', () => {
    const block = dynBlock();
    const grips = gripPoints(insert(), undefined, lookupOf(block));
    expect(grips).toHaveLength(3); // position + width + swing
    const local = dynamicGrips(insert(), block);
    expect(local.map((gr) => [gr.parameterId, gr.kind])).toEqual([
      ['width', 'linear-distance'],
      ['swing', 'angle'],
    ]);
    expect(local[0]!.localPoint).toEqual({ x: 14, y: 0 }); // basePoint + direction * effective value
    closeTo(local[1]!.localPoint.x, Math.cos(Math.PI / 6) * ANGLE_GRIP_RADIUS);
    closeTo(local[1]!.localPoint.y, Math.sin(Math.PI / 6) * ANGLE_GRIP_RADIUS);
  });

  it('value grip world position for a rotated, scaled insert follows the insert transform', () => {
    const block = dynBlock();
    const ins = insert({ rotation: Math.PI / 2, scale: 2 });
    const grips = gripPoints(ins, undefined, lookupOf(block));
    // width local (14, 0): scaled (28, 0), rotated 90deg -> (0, 28), + (100, 100).
    closeTo(grips[1]!.x, 100);
    closeTo(grips[1]!.y, 128);
    // swing local (cos30, sin30) * 1: scaled (1.732, 1), rotated 90deg -> (-1, 1.732), + position.
    closeTo(grips[2]!.x, 99);
    closeTo(grips[2]!.y, 101.73205080756888);
  });

  it('a parameter without a value grip contributes none; retained or invalid state contributes none', () => {
    const noValueGrip = dynBlock({
      dynamic: {
        ...definition(),
        parameters: definition().parameters.map((p) => (p.kind === 'linear-distance' ? { ...p, grips: [{ role: 'base', movesWithValue: false }] } : p)),
      },
    });
    expect(dynamicGrips(insert(), noValueGrip).map((gr) => gr.parameterId)).toEqual(['swing']);
    const retained = dynBlock({ dynamicRetained: '{"version":2}' });
    expect(dynamicGrips(insert(), retained)).toEqual([]);
    const invalid = insert({ dynamic: { block: 'GRIPBLK', values: { width: { kind: 'distance', value: 99 } } } });
    expect(dynamicGrips(invalid, dynBlock())).toEqual([]);
  });

  it('moveGrip index 0 still moves the insert position (the dynamic indices never reach it)', () => {
    const moved = moveGrip(insert(), 0, { x: 5, y: 6 });
    expect(moved).toMatchObject({ type: 'insert', position: { x: 5, y: 6 } });
  });
});

describe('dynamicGripEdit — a drag IS a parameter edit', () => {
  const stateOf = (ins: InsertEntity) => new Drawing({ entities: [ins], blocks: { GRIPBLK: dynBlock() }, currentLayer: '0' }).snapshot;

  it('projects the dragged world point onto the parameter direction (perpendicular offset ignored)', () => {
    const ins = insert({ rotation: Math.PI / 2, scale: 2 });
    const state = stateOf(ins);
    // Local target (16, 3) -> world: scaled (32, 6), rotated 90deg -> (-6, 32), + (100, 100).
    const r = dynamicGripEdit(state, 'A', 1, { x: 94, y: 132 });
    expect(r).toBeDefined();
    expect(r!.problem).toBeUndefined();
    const next = r!.state.entities[0] as InsertEntity;
    expect(next).not.toBe(ins);
    expect(next.id).toBe('A'); // identity preserved: selection survives the edit
    expect(next.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    // Input state untouched.
    expect((state.entities[0] as InsertEntity).dynamic?.values.width).toEqual({ kind: 'distance', value: 14 });
  });

  it('an out-of-constraint drag is refused and leaves the entity identical (same state object)', () => {
    const ins = insert();
    const state = stateOf(ins);
    // Local (25, 0) at identity transform, position (100, 100) -> world (125, 100); range max is 20.
    const r = dynamicGripEdit(state, 'A', 1, { x: 125, y: 100 });
    expect(r!.problem).toBe('value-out-of-range');
    expect(r!.state).toBe(state);
    expect(r!.state.entities[0]).toBe(ins);
  });

  it('angle drag measures the dragged point angle about the parameter base point', () => {
    const ins = insert({ position: { x: 0, y: 0 } });
    const state = stateOf(ins);
    const r = dynamicGripEdit(state, 'A', 2, { x: 5, y: -5 }); // -45 degrees
    expect(r!.problem).toBeUndefined();
    expect((r!.state.entities[0] as InsertEntity).dynamic?.values.swing).toEqual({ kind: 'angle', value: -Math.PI / 4 });
    // Beyond the 90-degree range the drag refuses instead of wrapping.
    const refused = dynamicGripEdit(state, 'A', 2, { x: -5, y: -5 });
    expect(refused!.problem).toBe('value-out-of-range');
    expect(refused!.state).toBe(state);
  });

  it('a mirrored insert inverts correctly', () => {
    const ins = insert({ position: { x: 0, y: 0 }, mirror: true });
    const state = stateOf(ins);
    const r = dynamicGripEdit(state, 'A', 1, { x: -16, y: 0 });
    expect(r!.problem).toBeUndefined();
    expect((r!.state.entities[0] as InsertEntity).dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
  });

  it('non-dynamic indices and inserts resolve to undefined (ordinary moveGrip path)', () => {
    const ins = insert();
    const state = stateOf(ins);
    expect(dynamicGripEdit(state, 'A', 0, { x: 0, y: 0 })).toBeUndefined();
    expect(dynamicGripEdit(state, 'A', 3, { x: 0, y: 0 })).toBeUndefined(); // past the last dynamic grip
    expect(dynamicGripEdit(state, 'missing', 1, { x: 0, y: 0 })).toBeUndefined();
    expect(dynamicGripDescriptor(state, 'A', 1)?.parameterId).toBe('width');
    expect(dynamicGripDescriptor(state, 'A', 2)?.parameterId).toBe('swing');
    expect(dynamicGripDescriptor(state, 'A', 0)).toBeUndefined();
  });
});
