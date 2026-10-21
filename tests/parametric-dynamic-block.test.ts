/**
 * Priority 30.1 — document-level acceptance for dynamic blocks (authored
 * normalized model; NOT native AutoCAD evidence).
 *
 * Covers: expansion evaluating per-instance values (two independent inserts),
 * nested transforms composed after evaluation, attributes preserved through
 * evaluation, setDynamicParameter as one transact = one undo step, atomic
 * refusal (same state object, no revision/dirty change), and the DYNSET tool
 * contract built on top of the pure apply function.
 */
import { describe, it, expect } from 'vitest';
import { Drawing, type DrawingState } from '../src/core/document';
import {
  explodeInsert,
  type AttributeDef,
  type BlockDef,
  type Entity,
  type InsertEntity,
  type LineEntity,
  type TextEntity,
} from '../src/core/entities';
import type { DynamicBlockDefinition } from '../src/core/parametric/definitions';
import { seedDynamicInstanceState, setDynamicParameter } from '../src/core/parametric/apply';
import { dynSetTool } from '../src/tools/parametric';
import { fakeContext, drive } from './fake-context';

// --- Fixture: block PANEL, width parameter (default 10, range 5..20) --------
// Rectangle 10x4; the stretch frame crosses its right edge and fully encloses
// the inner line and the attribute placement, so both move whole.
const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});

const definition = (): DynamicBlockDefinition => ({
  version: 1,
  parameters: [{
    kind: 'linear-distance', id: 'width', name: 'Width',
    basePoint: { x: 0, y: 0 }, direction: { x: 1, y: 0 },
    defaultValue: 10, constraint: { kind: 'range', min: 5, max: 20 },
    grips: [{ role: 'base', movesWithValue: false }, { role: 'value', movesWithValue: true }],
  }],
  actions: [{
    kind: 'stretch', id: 'S1', name: 'Stretch', parameterId: 'width',
    frame: { kind: 'rectangle', min: { x: 5, y: -1 }, max: { x: 15, y: 5 } },
    selection: [
      { entityId: 'L1', points: { kind: 'frame' } },
      { entityId: 'L2', points: { kind: 'frame' } },
      { entityId: 'L3', points: { kind: 'frame' } },
      { entityId: 'IN', points: { kind: 'frame' } },
      { entityId: 'TAG1', points: { kind: 'frame' } },
    ],
  }],
});

const panelBlock = (over: Partial<BlockDef> = {}): BlockDef => ({
  name: 'PANEL',
  basePoint: { x: 0, y: 0 },
  entities: [
    line('L1', 0, 0, 10, 0),
    line('L2', 10, 0, 10, 4),
    line('L3', 10, 4, 0, 4),
    line('L4', 0, 4, 0, 0),
    line('IN', 6, 1, 7, 1),
  ],
  attributes: [
    { tag: 'TAG1', prompt: 'Tag', default: 'P1', position: { x: 6, y: 2 }, height: 2, align: 'left' } as AttributeDef,
  ],
  dynamic: definition(),
  ...over,
});

const insert = (over: Partial<InsertEntity> = {}): InsertEntity => ({
  id: 'A', layer: '0', color: 'ByLayer', type: 'insert', block: 'PANEL',
  position: { x: 100, y: 100 }, rotation: 0, scale: 1,
  attributes: { TAG1: 'PANEL-A' },
  dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 14 } } },
  ...over,
});

const linesOf = (entities: readonly Entity[]): LineEntity[] => entities.filter((e): e is LineEntity => e.type === 'line');
const lineById = (entities: readonly Entity[], id: string): LineEntity => {
  const found = linesOf(entities).find((e) => e.id === id);
  expect(found, `line ${id} in expansion`).toBeDefined();
  return found!;
};
const textsOf = (entities: readonly Entity[]): TextEntity[] => entities.filter((e): e is TextEntity => e.type === 'text');

describe('expansion hook (core/entities.ts)', () => {
  it('two independent inserts of one definition expand to different geometry; the stored block is untouched', () => {
    const block = panelBlock();
    const blocks = { PANEL: block };
    const lookup = (n: string) => blocks[n as keyof typeof blocks];
    const a = insert();
    const b = insert({
      id: 'B', position: { x: 200, y: 100 }, attributes: { TAG1: 'PANEL-B' },
      dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 7 } } },
    });
    const ea = explodeInsert(a, lookup);
    const eb = explodeInsert(b, lookup);
    // Right edges: A stretched +4, B stretched -3, each in its own world offset.
    expect(lineById(ea, 'L2').a).toEqual({ x: 114, y: 100 });
    expect(lineById(ea, 'L2').b).toEqual({ x: 114, y: 104 });
    expect(lineById(eb, 'L2').a).toEqual({ x: 207, y: 100 });
    // The fully-enclosed inner line moves whole by the same delta.
    expect(lineById(ea, 'IN').a).toEqual({ x: 110, y: 101 });
    expect(lineById(ea, 'IN').b).toEqual({ x: 111, y: 101 });
    // The shared definition/block in state was NOT mutated or replaced by a
    // derived definition: base geometry is still authored at width 10.
    expect(lineById(block.entities, 'L2').a).toEqual({ x: 10, y: 0 });
    expect(blocks.PANEL).toBe(block);
  });

  it('an insert without dynamic values on a dynamic block expands at the authored default', () => {
    const blocks = { PANEL: panelBlock() };
    const lookup = (n: string) => blocks[n as keyof typeof blocks];
    const plain = insert({ dynamic: undefined });
    expect(lineById(explodeInsert(plain, lookup), 'L2').a).toEqual({ x: 110, y: 100 });
  });

  it('attributes are preserved through evaluation: value from the insert, placement moved by the stretch', () => {
    const blocks = { PANEL: panelBlock() };
    const lookup = (n: string) => blocks[n as keyof typeof blocks];
    const a = insert();
    const b = insert({
      id: 'B', position: { x: 200, y: 100 }, attributes: { TAG1: 'PANEL-B' },
      dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 7 } } },
    });
    const ta = textsOf(explodeInsert(a, lookup));
    const tb = textsOf(explodeInsert(b, lookup));
    expect(ta.map((t) => t.text)).toEqual(['PANEL-A']);
    expect(tb.map((t) => t.text)).toEqual(['PANEL-B']);
    // Unevaluated placement would be world x 106 (A) / 206 (B); the stretch
    // moved A's attribute placement +4 and B's -3 with its parameter delta.
    expect(ta[0]!.position.x).toBeGreaterThan(106);
    expect(tb[0]!.position.x).toBeLessThan(206);
    expect(ta[0]!.position.x - tb[0]!.position.x).toBeCloseTo(-93, 9); // (100+10) - (200+3)
    // The insert's own attribute record is untouched by evaluation.
    expect(a.attributes).toEqual({ TAG1: 'PANEL-A' });
  });

  it('evaluation refusal (invalid stored value, opaque action) falls back to the authored geometry', () => {
    const blocks = { PANEL: panelBlock() };
    const lookup = (n: string) => blocks[n as keyof typeof blocks];
    const invalid = insert({
      dynamic: { block: 'PANEL', values: { width: { kind: 'distance', value: 25 } } },
    });
    expect(lineById(explodeInsert(invalid, lookup), 'L2').a).toEqual({ x: 110, y: 100 });

    const opaqueDef: DynamicBlockDefinition = {
      ...definition(),
      actions: [{ kind: 'opaque-action', id: 'R1', name: 'Rotate', parameterId: 'width', sourceKind: 'rotate', payload: '{}' }],
    };
    const opaqueBlocks = { PANEL: panelBlock({ dynamic: opaqueDef }) };
    const opaqueLookup = (n: string) => opaqueBlocks[n as keyof typeof opaqueBlocks];
    expect(lineById(explodeInsert(insert(), opaqueLookup), 'L2').a).toEqual({ x: 110, y: 100 });
  });

  it('a dynamic insert nested in another block evaluates, then composes with rotation, scale and mirror', () => {
    const panel = panelBlock();
    const outer: BlockDef = {
      name: 'OUTER', basePoint: { x: 0, y: 0 }, attributes: [],
      entities: [
        line('OL', 0, 0, 1, 0),
        insert({ id: 'NI', position: { x: 0, y: 0 }, attributes: { TAG1: 'NESTED' } }),
      ],
    };
    const blocks = { PANEL: panel, OUTER: outer };
    const lookup = (n: string) => blocks[n as keyof typeof blocks];
    const top = insert({
      id: 'TOP', block: 'OUTER', position: { x: 0, y: 0 },
      rotation: Math.PI / 2, scale: 2, mirror: true, attributes: {}, dynamic: undefined,
    });
    const expanded = explodeInsert(top, lookup);
    // Evaluated L2 in PANEL space: (14,0)-(14,4). Nested transform: identity.
    // Outer transform: sx=-2, sy=2, rotate 90°: (14,0) -> (0,-28) and
    // (14,4) -> (-8,-28), up to rotation floating-point noise.
    const l2 = lineById(expanded, 'L2');
    expect(l2.a.x).toBeCloseTo(0, 9);
    expect(l2.a.y).toBeCloseTo(-28, 9);
    expect(l2.b.x).toBeCloseTo(-8, 9);
    expect(l2.b.y).toBeCloseTo(-28, 9);
    // The nested insert's attribute value survives evaluation + composition.
    expect(textsOf(expanded).map((t) => t.text)).toEqual(['NESTED']);
  });
});

describe('setDynamicParameter (core/parametric/apply.ts)', () => {
  const stateWith = (entities: Entity[], block: BlockDef = panelBlock()): DrawingState => ({
    entities,
    layers: [{ name: '0', color: 7, visible: true, locked: false, lineWeight: 0.25 }],
    blocks: { [block.name]: block },
    currentLayer: '0',
  });

  it('success: new insert object with sparse updated values; definition and other entities shared by identity', () => {
    const a = insert();
    const b = insert({ id: 'B', position: { x: 200, y: 100 } });
    const block = panelBlock();
    const state = stateWith([a, b], block);
    const r = setDynamicParameter(state, 'A', 'width', 16);
    expect(r.problem).toBeUndefined();
    expect(r.state).not.toBe(state);
    const nextA = r.state.entities.find((e) => e.id === 'A') as InsertEntity;
    expect(nextA).not.toBe(a);
    expect(nextA.dynamic).toEqual({ block: 'PANEL', values: { width: { kind: 'distance', value: 16 } } });
    expect(r.state.entities.find((e) => e.id === 'B')).toBe(b);
    expect(r.state.blocks.PANEL).toBe(block); // definition immutable, untouched
    expect(a.dynamic?.values.width).toEqual({ kind: 'distance', value: 14 }); // input not mutated
  });

  it('seeds default (sparse) instance state onto an insert that had none', () => {
    const state = stateWith([insert({ dynamic: undefined })]);
    const r = setDynamicParameter(state, 'A', 'width', 12);
    expect(r.problem).toBeUndefined();
    const nextA = r.state.entities[0] as InsertEntity;
    expect(nextA.dynamic).toEqual({ block: 'PANEL', values: { width: { kind: 'distance', value: 12 } } });
  });

  it('refusals return the SAME state object with a stable problem code', () => {
    const state = stateWith([insert()]);
    const cases: [string, string, number, string][] = [
      ['missing', 'width', 12, 'insert-not-found'],
      ['A', 'height', 12, 'unknown-parameter'],
      ['A', 'width', 25, 'value-out-of-range'],
      ['A', 'width', Number.NaN, 'non-finite-value'],
    ];
    for (const [id, param, value, code] of cases) {
      const r = setDynamicParameter(state, id, param, value);
      expect(r.state, code).toBe(state);
      expect(r.problem, code).toBe(code);
    }
    const same = setDynamicParameter(state, 'A', 'width', 14);
    expect(same.state).toBe(state);
    expect(same.problem).toBe('no-change');

    const staticState = stateWith([insert()], panelBlock({ dynamic: undefined }));
    const rStatic = setDynamicParameter(staticState, 'A', 'width', 12);
    expect(rStatic.state).toBe(staticState);
    expect(rStatic.problem).toBe('no-dynamic-definition');
  });

  it('an opaque/retained definition refuses edits whole (never evaluated around)', () => {
    const block = panelBlock({ dynamic: undefined, dynamicRetained: '{"v":99}' });
    const state = stateWith([insert()], block);
    const r = setDynamicParameter(state, 'A', 'width', 12);
    expect(r.state).toBe(state);
    expect(r.problem).toBe('definition-retained');
  });

  it('seedDynamicInstanceState: sparse defaults for a dynamic block, none for static/retained', () => {
    expect(seedDynamicInstanceState(panelBlock())).toEqual({ block: 'PANEL', values: {} });
    expect(seedDynamicInstanceState(panelBlock({ dynamic: undefined }))).toBeUndefined();
    expect(seedDynamicInstanceState(panelBlock({ dynamicRetained: '{"v":99}' }))).toBeUndefined();
  });
});

describe('document integration: one edit = one undo step', () => {
  const makeDoc = (): Drawing => new Drawing({
    entities: [insert()],
    blocks: { PANEL: panelBlock() },
    currentLayer: '0',
  });
  const expandedRightEdge = (doc: Drawing): number => {
    const ins = doc.entities.find((e) => e.id === 'A') as InsertEntity;
    const lookup = (n: string) => doc.blocks[n];
    return lineById(explodeInsert(ins, lookup), 'L2').a.x;
  };

  it('accepted edit: dirty set, one undo restores prior geometry, redo reapplies', () => {
    const doc = makeDoc();
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    expect(doc.dirty).toBe(false);
    expect(expandedRightEdge(doc)).toBe(114);

    const r = setDynamicParameter(doc.snapshot, 'A', 'width', 16);
    expect(r.problem).toBeUndefined();
    doc.transact(() => r.state); // the DYNSET commit shape: exactly one transact

    expect(doc.dirty).toBe(true);
    expect(doc.revision).toBe(revisionBefore + 1);
    expect(expandedRightEdge(doc)).toBe(116);

    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(expandedRightEdge(doc)).toBe(114);
    expect(doc.canUndo()).toBe(false);

    expect(doc.redo()).toBe(true);
    expect(expandedRightEdge(doc)).toBe(116);
  });

  it('refused edit leaves the document identical: same snapshot object, no revision or dirty change, no undo step', () => {
    const doc = makeDoc();
    const before = doc.snapshot;
    const revisionBefore = doc.revision;
    const r = setDynamicParameter(doc.snapshot, 'A', 'width', 25);
    expect(r.problem).toBe('value-out-of-range');
    expect(r.state).toBe(before);
    // Tool contract on refusal: no transact is issued at all.
    expect(doc.snapshot).toBe(before);
    expect(doc.revision).toBe(revisionBefore);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
  });
});

describe('DYNSET tool (src/tools/parametric.ts)', () => {
  const makeDoc = (): Drawing => new Drawing({
    entities: [insert()],
    blocks: { PANEL: panelBlock() },
    currentLayer: '0',
  });

  it('commits an accepted value through one transact (one undo step)', () => {
    const doc = makeDoc();
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['A']);
    drive(dynSetTool(), ctx, ['16']);
    const ins = doc.entities.find((e) => e.id === 'A') as InsertEntity;
    expect(ins.dynamic?.values.width).toEqual({ kind: 'distance', value: 16 });
    expect(ctx.logs.some((l) => l.includes('Width') && l.includes('16'))).toBe(true);
    expect(doc.dirty).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.canUndo()).toBe(false);
    const restored = doc.entities.find((e) => e.id === 'A') as InsertEntity;
    expect(restored.dynamic?.values.width).toEqual({ kind: 'distance', value: 14 });
  });

  it('a refused value logs the problem code and does not transact', () => {
    const doc = makeDoc();
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['A']);
    drive(dynSetTool(), ctx, ['25']);
    expect(ctx.logs.some((l) => l.includes('DYNSET refused (value-out-of-range)'))).toBe(true);
    expect(doc.snapshot).toBe(before);
    expect(doc.dirty).toBe(false);
    expect(doc.canUndo()).toBe(false);
  });
});
