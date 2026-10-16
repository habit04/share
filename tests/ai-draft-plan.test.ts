import { describe, expect, it } from 'vitest';
import { parseAiDraftResponse } from '../src/ai/draft-plan';

const op = (over: Record<string, unknown>): Record<string, unknown> => ({
  op: 'createLine',
  a: { x: 0, y: 0 },
  b: { x: 10, y: 0 },
  center: null, radius: null, origin: null, width: null, height: null,
  rotationDeg: null, layer: null, targetIds: null, dx: null, dy: null,
  pivot: null, angleDeg: null,
  ...over,
});
const proposal = (operations: unknown[], message: unknown = null): unknown => ({ outcome: 'proposal', message, operations });

describe('parseAiDraftResponse', () => {
  it('accepts a minimal valid plan and a clarification', () => {
    const ok = parseAiDraftResponse(proposal([op({})]));
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.response.kind === 'plan') {
      expect(ok.response.plan.operations).toHaveLength(1);
    } else throw new Error('expected plan');
    const clar = parseAiDraftResponse({ outcome: 'clarification', message: 'What radius?', operations: null });
    expect(clar.ok && clar.response.kind === 'clarification').toBe(true);
  });

  it('rejects unknown ops, unknown fields, and misplaced fields', () => {
    expect(parseAiDraftResponse(proposal([op({ op: 'explode' })])).ok).toBe(false);
    expect(parseAiDraftResponse(proposal([op({ script: 'alert(1)' })])).ok).toBe(false);
    expect(parseAiDraftResponse(proposal([op({ radius: 5 })])).ok).toBe(false); // radius on a line
    expect(parseAiDraftResponse({ outcome: 'proposal', message: null, operations: [op({})], extra: 1 }).ok).toBe(false);
  });

  it('rejects invalid geometry values', () => {
    expect(parseAiDraftResponse(proposal([op({ b: { x: Number.POSITIVE_INFINITY, y: 0 } })])).ok).toBe(false);
    expect(parseAiDraftResponse(proposal([op({ a: { x: 0, y: 0 }, b: { x: 0, y: 0 } })])).ok).toBe(false); // zero length
    expect(parseAiDraftResponse(proposal([op({ op: 'createCircle', a: null, b: null, center: { x: 0, y: 0 }, radius: -2 })])).ok).toBe(false);
    expect(parseAiDraftResponse(proposal([op({ op: 'createCircle', a: null, b: null, center: { x: 0, y: 0 }, radius: 2 })])).ok).toBe(true);
    expect(parseAiDraftResponse(proposal([op({ op: 'createRectangle', a: null, b: null, origin: { x: 0, y: 0 }, width: 0, height: 5 })])).ok).toBe(false);
  });

  it('rejects no-op edits, empty plans, and conflicting targets', () => {
    const move = (dx: number, dy: number, ids: string[]): Record<string, unknown> => op({
      op: 'move', a: null, b: null, targetIds: ids, dx, dy,
    });
    expect(parseAiDraftResponse(proposal([move(0, 0, ['e1'])])).ok).toBe(false);
    expect(parseAiDraftResponse(proposal([])).ok).toBe(false);
    expect(parseAiDraftResponse(proposal([move(1, 0, ['e1']), move(2, 0, ['e1'])])).ok).toBe(false);
    const rotate = op({ op: 'rotate', a: null, b: null, targetIds: ['e1'], pivot: { x: 0, y: 0 }, angleDeg: 360 });
    expect(parseAiDraftResponse(proposal([rotate])).ok).toBe(false);
    const del = op({ op: 'delete', a: null, b: null, targetIds: ['e1', 'e1'] });
    expect(parseAiDraftResponse(proposal([del])).ok).toBe(false); // duplicate ids in one op
  });

  it('rejects clarification carrying operations and oversized messages', () => {
    expect(parseAiDraftResponse({ outcome: 'unsupported', message: 'no', operations: [op({})] }).ok).toBe(false);
    expect(parseAiDraftResponse({ outcome: 'clarification', message: 'x'.repeat(1001), operations: null }).ok).toBe(false);
    expect(parseAiDraftResponse({ outcome: 'clarification', message: '', operations: null }).ok).toBe(false);
  });

  it('rejects excessive operation counts', () => {
    const many = Array.from({ length: 65 }, () => op({}));
    expect(parseAiDraftResponse(proposal(many)).ok).toBe(false);
  });

  it('rejects prototype operation names, inherited coordinates and throwing data without throwing', () => {
    for (const name of ['toString', 'constructor', '__proto__']) {
      expect(parseAiDraftResponse(proposal([op({ op: name })])).ok).toBe(false);
    }
    const inherited = Object.assign(Object.create({ x: 1, y: 2 }) as object, { left: 1, right: 2 });
    expect(parseAiDraftResponse(proposal([op({ a: inherited })])).ok).toBe(false);
    const accessor = Object.defineProperty({}, 'outcome', { enumerable: true, get: () => { throw new Error('not data'); } });
    expect(() => parseAiDraftResponse(accessor)).not.toThrow();
    expect(parseAiDraftResponse(accessor).ok).toBe(false);
    for (const value of [null, undefined, [], 1]) expect(parseAiDraftResponse(value).ok).toBe(false);
  });

  it('takes immutable ownership of a copy, leaving provider-owned target arrays mutable', () => {
    const ids = ['e1'];
    const raw = proposal([op({ op: 'move', a: null, b: null, targetIds: ids, dx: 1, dy: 2 })]);
    const parsed = parseAiDraftResponse(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.response.kind !== 'plan') return;
    ids[0] = 'e2';
    const move = parsed.response.plan.operations[0];
    expect(move && 'targetIds' in move && move.targetIds).toEqual(['e1']);
    expect(Object.isFrozen(parsed.response.plan.operations)).toBe(true);
    expect(Object.isFrozen(move)).toBe(true);
    expect(move && 'targetIds' in move && Object.isFrozen(move.targetIds)).toBe(true);
  });

  it('rejects oversized plans even when operation and target counts fit', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `${i}-${'x'.repeat(500)}`);
    expect(parseAiDraftResponse(proposal([op({ op: 'delete', a: null, b: null, targetIds: ids })])).ok).toBe(false);
    expect(parseAiDraftResponse({ outcome: 'clarification', message: '   ', operations: null }).ok).toBe(false);
  });
});
