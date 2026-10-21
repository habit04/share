/**
 * Priority 30 review §3 — the constraint commands (CONADD / CONEDIT /
 * CONDELETE / CONSOLVE / CONSTATUS) driven through the ACTUAL tool path
 * (fakeContext + drive), not through the pure adapter: prompts, anchor
 * resolution from selection, refusal logging with codes, exactly-one
 * undo step per accepted operation, and the stated boundaries (model
 * space only; line/circle/arc/polyline/point only; retained payloads
 * refuse).
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { CircleEntity, LineEntity, PointEntity, TextEntity } from '../src/core/entities';
import type { ConstraintSet } from '../src/core/constraints/model';
import { conAddTool, conDeleteTool, conEditTool, conSolveTool, conStatusTool } from '../src/tools/constraints';
import { defaultLayout, type Layout } from '../src/core/layouts';
import { fakeContext, drive, type FakeContext } from './fake-context';

const line = (id: string, ax: number, ay: number, bx: number, by: number): LineEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'line', a: { x: ax, y: ay }, b: { x: bx, y: by },
});
const point = (id: string, x: number, y: number): PointEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'point', position: { x, y },
});
const circle = (id: string, x: number, y: number, r: number): CircleEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'circle', center: { x, y }, radius: r,
});
const textEnt = (id: string): TextEntity => ({
  id, layer: '0', color: 'ByLayer', type: 'text', position: { x: 0, y: 0 }, text: 'X', height: 2, rotation: 0, align: 'left',
});
const byId = <T extends { id: string }>(entities: readonly T[], id: string): T => entities.find((e) => e.id === id)!;
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);
const logs = (ctx: FakeContext): string => ctx.logs.join('\n');

/** L1 (0,0)-(10,0); P1 at (13,4): distance(L1.end, P1) is exactly 5. */
const docWithLinePoint = (over: Partial<ConstructorParameters<typeof Drawing>[0]> = {}): Drawing =>
  new Drawing({ entities: [line('L1', 0, 0, 10, 0), point('P1', 13, 4), circle('C1', -5, -5, 2)], currentLayer: '0', ...over });

const distanceSet = (value: number, id = 'c-d'): ConstraintSet => ({
  constraints: [
    { id, kind: 'distance', role: 'driving', value, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
  ],
});

describe('CONADD', () => {
  it('distance between two picked anchors at the measured default: added, solved, exactly one undo step', () => {
    const doc = docWithLinePoint();
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1', 'P1']);
    drive(conAddTool(), ctx, ['Distance', 'Points', 'End', '', '', '']);
    const set = doc.snapshot.constraints;
    expect(set?.constraints).toHaveLength(1);
    const c = set!.constraints[0]!;
    expect(c.kind).toBe('distance');
    expect(c.role).toBe('driving');
    expect(c.value).toBe(5);
    expect(c.refs).toEqual([
      { entityId: 'L1', anchor: 'end' },
      { entityId: 'P1', anchor: 'position' },
    ]);
    expect(logs(ctx)).toContain('Solve:');
    expect(doc.canUndo()).toBe(true);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.constraints).toBeUndefined();
    expect(doc.canUndo()).toBe(false);
  });

  it('distance with an explicit value moves geometry to satisfy it in the same step', () => {
    const doc = docWithLinePoint();
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1', 'P1']);
    drive(conAddTool(), ctx, ['Distance', 'Points', 'End', '', '', '10']);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    const p1 = byId(doc.snapshot.entities, 'P1') as PointEntity;
    expect(dist(l1.b, p1.position)).toBeCloseTo(10, 6);
    expect(doc.snapshot.constraints?.constraints[0]?.value).toBe(10);
  });

  it('coincident joins two endpoints (selection order = ref order)', () => {
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 0), line('L2', 10, 5, 20, 5)], currentLayer: '0' });
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1', 'L2']);
    drive(conAddTool(), ctx, ['Coincident', 'Points', 'End', 'Start']);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    const l2 = byId(doc.snapshot.entities, 'L2') as LineEntity;
    expect(Math.abs(l1.b.x - l2.a.x)).toBeLessThan(1e-6);
    expect(Math.abs(l1.b.y - l2.a.y)).toBeLessThan(1e-6);
    expect(doc.snapshot.constraints?.constraints[0]?.kind).toBe('coincident');
  });

  it('horizontal (segment form) levels a slanted line', () => {
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 3)], currentLayer: '0' });
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1']);
    drive(conAddTool(), ctx, ['Horizontal', 'Segment']);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    expect(l1.b.y).toBeCloseTo(l1.a.y, 9);
    expect(doc.snapshot.constraints?.constraints[0]?.refs).toEqual([{ entityId: 'L1', anchor: 'whole' }]);
  });

  it('reference radius: stored without a value, geometry untouched', () => {
    const doc = docWithLinePoint();
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['C1']);
    drive(conAddTool(), ctx, ['Radius', 'Reference']);
    const c = doc.snapshot.constraints?.constraints[0];
    expect(c?.kind).toBe('radius');
    expect(c?.role).toBe('reference');
    expect(c?.value).toBeUndefined();
    expect(byId(doc.snapshot.entities, 'C1')).toBe(byId(before.entities, 'C1'));
  });

  it('a negative driving distance is refused by validation: logged code, no transact, no undo', () => {
    const doc = docWithLinePoint();
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1', 'P1']);
    drive(conAddTool(), ctx, ['Distance', 'Points', 'End', '', '', '-5']);
    expect(logs(ctx)).toContain('CONADD refused');
    expect(logs(ctx)).toContain('invalid-value');
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('concentric on two lines is refused at the prompt (no curve), nothing stored', () => {
    const doc = new Drawing({ entities: [line('L1', 0, 0, 10, 0), line('L2', 0, 5, 10, 5)], currentLayer: '0' });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['L1', 'L2']);
    drive(conAddTool(), ctx, ['Concentric']);
    expect(logs(ctx)).toContain('is not a curve');
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('a text entity cannot be constrained: prompt refusal names the supported list', () => {
    const doc = new Drawing({ entities: [textEnt('T1')], currentLayer: '0' });
    const ctx = fakeContext(doc);
    ctx.selection = new Set(['T1']);
    drive(conAddTool(), ctx, ['Fixed']);
    expect(logs(ctx)).toContain('cannot be constrained');
    expect(doc.snapshot.constraints).toBeUndefined();
    expect(doc.canUndo()).toBe(false);
  });

  it('paper space: refused with a diagnostic before any prompt', () => {
    const lay: Layout = { ...defaultLayout('Layout1'), pristine: undefined, viewports: [], entities: [] };
    const doc = docWithLinePoint({ layouts: [lay], space: { layout: 'Layout1' } });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    drive(conAddTool(), ctx, []);
    expect(logs(ctx)).toContain('Model tab');
    expect(doc.snapshot).toBe(before);
  });
});

describe('CONEDIT', () => {
  it('edits a driving value and re-solves in one undo step', () => {
    const doc = docWithLinePoint({ constraints: distanceSet(5) });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    drive(conEditTool(), ctx, ['', '10']);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    const p1 = byId(doc.snapshot.entities, 'P1') as PointEntity;
    expect(dist(l1.b, p1.position)).toBeCloseTo(10, 6);
    expect(doc.snapshot.constraints?.constraints[0]?.value).toBe(10);
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot).toBe(before);
  });

  it('an edit that conflicts with another constraint refuses whole: logged code, document identical', () => {
    const both: ConstraintSet = {
      constraints: [
        { id: 'c-d5', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        { id: 'c-d7', kind: 'distance', role: 'driving', value: 7, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const doc = docWithLinePoint({ constraints: both });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    drive(conEditTool(), ctx, ['', '6']);
    expect(logs(ctx)).toContain('CONEDIT refused');
    expect(logs(ctx)).toContain('conflicting-constraints');
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });

  it('a reference-only set has nothing to edit', () => {
    const ref: ConstraintSet = {
      constraints: [{ id: 'c-r', kind: 'radius', role: 'reference', refs: [{ entityId: 'C1', anchor: 'whole' }] }],
    };
    const doc = docWithLinePoint({ constraints: ref });
    const ctx = fakeContext(doc);
    drive(conEditTool(), ctx, []);
    expect(logs(ctx)).toContain('no driving dimensional constraint');
    expect(doc.canUndo()).toBe(false);
  });

  it('naming a geometric constraint refuses with the reason', () => {
    const set: ConstraintSet = {
      constraints: [
        { id: 'c-co', kind: 'coincident', role: 'driving', refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        ...distanceSet(5).constraints,
      ],
    };
    const doc = docWithLinePoint({ constraints: set });
    const ctx = fakeContext(doc);
    drive(conEditTool(), ctx, ['c-co']);
    expect(logs(ctx)).toContain('has no driving value to edit');
    expect(doc.canUndo()).toBe(false);
  });
});

describe('CONDELETE', () => {
  it('deleting the last constraint removes the set; one undo restores it', () => {
    const doc = docWithLinePoint({ constraints: distanceSet(5) });
    const ctx = fakeContext(doc);
    drive(conDeleteTool(), ctx, ['']);
    expect(doc.snapshot.constraints).toBeUndefined();
    expect(logs(ctx)).toContain('now empty');
    expect(doc.undo()).toBe(true);
    expect(doc.snapshot.constraints?.constraints).toHaveLength(1);
  });

  it('an unknown id is refused in the log and changes nothing', () => {
    const doc = docWithLinePoint({ constraints: distanceSet(5) });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    drive(conDeleteTool(), ctx, ['nope']);
    expect(logs(ctx)).toContain("No constraint 'nope'");
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
  });
});

describe('CONSOLVE', () => {
  it('solves a violated set in one undo step and reports the status', () => {
    const doc = new Drawing({
      entities: [line('L1', 0, 0, 10, 0), point('P1', 13, 9)],
      constraints: distanceSet(5),
      currentLayer: '0',
    });
    const ctx = fakeContext(doc);
    drive(conSolveTool(), ctx, []);
    const l1 = byId(doc.snapshot.entities, 'L1') as LineEntity;
    const p1 = byId(doc.snapshot.entities, 'P1') as PointEntity;
    expect(dist(l1.b, p1.position)).toBeCloseTo(5, 6);
    expect(logs(ctx)).toContain('CONSOLVE: underconstrained');
    expect(doc.canUndo()).toBe(true);
  });

  it('a conflicting set fails with the solver code and leaves the document identical', () => {
    const both: ConstraintSet = {
      constraints: [
        { id: 'c-d5', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        { id: 'c-d7', kind: 'distance', role: 'driving', value: 7, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const doc = docWithLinePoint({ constraints: both });
    const before = doc.snapshot;
    const ctx = fakeContext(doc);
    drive(conSolveTool(), ctx, []);
    expect(logs(ctx)).toContain('CONSOLVE failed');
    expect(logs(ctx)).toContain('conflicting-constraints');
    expect(doc.snapshot).toBe(before);
    expect(doc.canUndo()).toBe(false);
    expect(doc.dirty).toBe(false);
  });

  it('no constraints: a plain report, no transact', () => {
    const doc = docWithLinePoint();
    const ctx = fakeContext(doc);
    drive(conSolveTool(), ctx, []);
    expect(logs(ctx)).toContain('no constraints');
    expect(doc.canUndo()).toBe(false);
  });
});

describe('CONSTATUS', () => {
  it('reports satisfied / violated-with-measured / reference / suppressed and the DOF line', () => {
    const set: ConstraintSet = {
      constraints: [
        { id: 'c-ok', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        { id: 'c-bad', kind: 'distance', role: 'driving', value: 99, refs: [{ entityId: 'L1', anchor: 'end' }, { entityId: 'P1', anchor: 'position' }] },
        { id: 'c-ref', kind: 'radius', role: 'reference', refs: [{ entityId: 'C1', anchor: 'whole' }] },
        { id: 'c-sup', kind: 'coincident', role: 'driving', suppressed: true, refs: [{ entityId: 'L1', anchor: 'start' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const doc = docWithLinePoint({ constraints: set });
    const ctx = fakeContext(doc);
    drive(conStatusTool(), ctx, []);
    const out = logs(ctx);
    expect(out).toContain('c-ok');
    expect(out).toContain('satisfied (target 5, measured 5.0000)');
    expect(out).toContain('not satisfied (target 99, measured 5.0000)');
    expect(out).toContain('reference — measured 2.0000');
    expect(out).toContain('suppressed');
    expect(out).toContain('DOF total');
    expect(doc.canUndo()).toBe(false); // read-only: no transact
  });

  it('a set with a missing reference reports the problem instead of a status', () => {
    const set: ConstraintSet = {
      constraints: [
        { id: 'c-orphan', kind: 'distance', role: 'driving', value: 5, refs: [{ entityId: 'ZZ', anchor: 'position' }, { entityId: 'P1', anchor: 'position' }] },
      ],
    };
    const doc = docWithLinePoint({ constraints: set });
    const ctx = fakeContext(doc);
    drive(conStatusTool(), ctx, []);
    expect(logs(ctx)).toContain('missing-reference');
  });

  it('no constraints and retained payloads are reported, not guessed', () => {
    const plain = fakeContext(docWithLinePoint());
    drive(conStatusTool(), plain, []);
    expect(logs(plain)).toContain('no constraints in this drawing');

    const retained = fakeContext(docWithLinePoint({ constraintsRetained: '{"v":99}' }));
    drive(conStatusTool(), retained, []);
    expect(logs(retained)).toContain('cannot model');
  });
});
