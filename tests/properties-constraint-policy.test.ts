/**
 * Priority 30 review round 2 (C08) — the Properties palette handles
 * constraint-policy refusals (headless fake-DOM; NOT native evidence).
 *
 * Round 1's geometry-edit policy refuses edits inside
 * Drawing.commitTransition by throwing ConstraintPolicyError. The
 * palette's geometry setter caught only GeometryBudgetError, so a
 * refused edit escaped the change handler: the document stayed unchanged
 * (the policy did its job) but the user got no command-log refusal and
 * the field kept the stale typed value. These tests drive the actual
 * palette (fake DOM, real Editor) for: a fixed-anchor refusal, a
 * solve-failure refusal, the same refusal on another entity type, and
 * the feasible-edit control committing as exactly one undo step.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Editor as EditorType } from '../src/app/editor';
import type { PropertiesPalette as PaletteType } from '../src/ui/properties';
import type { CircleEntity, Entity, LineEntity } from '../src/core/entities';
import type { ConstraintSet } from '../src/core/constraints/model';
import { FakeElement, installFakeDocument } from './helpers/fake-dom';

let Editor: typeof EditorType;
let PropertiesPalette: typeof PaletteType;
let uninstall = () => {};
beforeAll(async () => {
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  uninstall = installFakeDocument();
  ({ Editor } = await import('../src/app/editor'));
  ({ PropertiesPalette } = await import('../src/ui/properties'));
}, 120000);
afterAll(() => { uninstall(); vi.unstubAllGlobals(); });

function fixture(entities: Entity[], constraints: ConstraintSet) {
  const canvas = { getContext: () => ({}), getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 }), width: 0, height: 0 } as unknown as HTMLCanvasElement;
  const ed = new Editor(canvas);
  ed.doc.load({ ...ed.doc.snapshot, entities, constraints });
  const container = new FakeElement('div');
  const palette = new PropertiesPalette(ed, container as unknown as HTMLElement);
  palette.toggle();
  ed.selection = new Set([entities[0]!.id]);
  ed.notify('selection');
  const field = (label: string) => {
    const body = container.children[0]!.children[1]!;
    const row = body.children.find((element) => element.classes.has('prop-row') && element.children[0]!.textContent === label);
    if (!row) throw new Error(`Missing properties field ${label}`);
    return row.children[1]!;
  };
  return { ed, field };
}

const line: LineEntity = { id: 'L', type: 'line', layer: '0', color: 'ByLayer', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } };
const fixedStart: ConstraintSet = { constraints: [
  { id: 'fixed-start', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L', anchor: 'start' }] },
  { id: 'horizontal', kind: 'horizontal', role: 'driving', refs: [{ entityId: 'L', anchor: 'whole' }] },
] };

describe('Properties palette and the constraint policy (C08)', () => {
  it('reports a fixed-anchor refusal, restores the field and changes nothing', () => {
    const { ed, field } = fixture([line], fixedStart);
    const before = ed.doc.snapshot;
    const input = field('Start X');
    input.value = '2';
    expect(() => input.fire('change')).not.toThrow();
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.canUndo()).toBe(false);
    expect(ed.doc.dirty).toBe(false);
    expect(ed.history.some((m) => m.includes('fixed-start'))).toBe(true);
    expect(field('Start X').value).toBe('0.0000');
  });

  it('reports a solve-failure refusal the same way (fixed start + driving length)', () => {
    const set: ConstraintSet = { constraints: [
      { id: 'fixed-start', kind: 'fixed', role: 'driving', refs: [{ entityId: 'L', anchor: 'start' }] },
      { id: 'len', kind: 'distance', role: 'driving', value: 10, refs: [{ entityId: 'L', anchor: 'start' }, { entityId: 'L', anchor: 'end' }] },
    ] };
    const { ed, field } = fixture([line], set);
    const before = ed.doc.snapshot;
    const input = field('End X');
    input.value = '12';
    expect(() => input.fire('change')).not.toThrow();
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.doc.canUndo()).toBe(false);
    expect(ed.history.some((m) => /constraint|refus/i.test(m))).toBe(true);
    expect(field('End X').value).toBe('10.0000');
  });

  it('applies the same handling to other geometry fields (circle centre under a fixed centre)', () => {
    const circle: CircleEntity = { id: 'C', type: 'circle', layer: '0', color: 'ByLayer', center: { x: 5, y: 5 }, radius: 3 };
    const set: ConstraintSet = { constraints: [
      { id: 'fixed-centre', kind: 'fixed', role: 'driving', refs: [{ entityId: 'C', anchor: 'center' }] },
    ] };
    const { ed, field } = fixture([circle], set);
    const before = ed.doc.snapshot;
    const input = field('Center X');
    input.value = '9';
    expect(() => input.fire('change')).not.toThrow();
    expect(ed.doc.snapshot).toBe(before);
    expect(ed.history.some((m) => m.includes('fixed-centre'))).toBe(true);
    expect(field('Center X').value).toBe('5.0000');
  });

  it('a feasible constrained edit still commits as exactly one undo step', () => {
    const { ed, field } = fixture([line], fixedStart);
    const input = field('End X');
    input.value = '12';
    expect(() => input.fire('change')).not.toThrow();
    expect((ed.doc.entities[0] as LineEntity).b).toEqual({ x: 12, y: 0 });
    expect(ed.doc.canUndo()).toBe(true);
    ed.doc.undo();
    expect((ed.doc.entities[0] as LineEntity).b).toEqual({ x: 10, y: 0 });
    expect(ed.doc.canUndo()).toBe(false);
  });
});
