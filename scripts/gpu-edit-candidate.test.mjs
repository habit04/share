import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseBenchmarkLineEdit } from './gpu-edit-candidate.mjs';

const line = (id, a, b, extra = {}) => ({ id, type: 'line', layer: '0', color: 7, a, b, ...extra });
const view = { center: { x: 0, y: 0 }, width: 120, height: 100, scale: 2, twist: 0 };
const state = (entities) => ({ entities, layers: [{ name: '0', visible: true }] });

test('ranks a long existing stroke ahead of the old latest tiny midpoint candidate', () => {
  const long = line('LONG', { x: -10, y: 0 }, { x: 10, y: 0 });
  const short = line('LATEST', { x: 0, y: 3 }, { x: 0, y: 4 });
  const input = state([long, short]), before = JSON.stringify(input);
  const result = chooseBenchmarkLineEdit(input, view);
  assert.equal(result.original, long); assert.equal(result.sourceIndex, 0);
  assert.equal(result.perpendicularDisplacementCss, 2);
  assert.deepEqual(result.worldVector, { x: -0, y: 1 });
  assert.equal(result.edited.id, long.id); assert.equal(result.edited.color, long.color);
  assert.equal(JSON.stringify(input), before);
});

test('preserves a frozen ID when a later camera would favor a different line', () => {
  const input = state([line('A', { x: -10, y: 0 }, { x: 10, y: 0 }), line('B', { x: 0, y: -12 }, { x: 0, y: 12 })]);
  const result = chooseBenchmarkLineEdit(input, { ...view, twist: .17 }, 'A');
  assert.equal(result.original.id, 'A'); assert.ok(Math.abs(result.perpendicularDisplacementCss - 2) < 1e-12);
  assert.throws(() => chooseBenchmarkLineEdit(input, { ...view, center: { x: 1000, y: 1000 } }, 'A'), /Frozen edit LINE A/);
});

test('rejects hidden, degenerate, offscreen and sub-ULP edits while keeping 1e12 precision measurable', () => {
  const o = 1e12;
  const input = state([line('L', { x: o - 1 / 16, y: o }, { x: o + 1 / 16, y: o })]);
  const result = chooseBenchmarkLineEdit(input, { ...view, width: 1200, center: { x: o, y: o }, scale: 4096 });
  assert.equal(result.edited.a.y - o, 1 / 2048); assert.equal(result.displacementCss, 2);
  assert.throws(() => chooseBenchmarkLineEdit(input, { ...view, width: 1200, center: { x: o, y: o }, scale: 1e9 }), /representable visible/);
  assert.throws(() => chooseBenchmarkLineEdit({ ...input, layers: [{ name: '0', visible: false }] }, { ...view, center: { x: o, y: o } }), /representable visible/);
  assert.throws(() => chooseBenchmarkLineEdit(state([line('ZERO', { x: 0, y: 0 }, { x: 0, y: 0 })]), view), /representable visible/);
});

test('prefers full inset endpoints; clipped candidates stay explicit and deterministic', () => {
  const clipped = line('CLIPPED', { x: -100, y: -4 }, { x: 100, y: -4 });
  const inset = line('INSET', { x: -10, y: 0 }, { x: 10, y: 0 });
  assert.equal(chooseBenchmarkLineEdit(state([clipped, inset]), view).original.id, 'INSET');
  const only = chooseBenchmarkLineEdit(state([clipped]), view);
  assert.equal(only.fullyInset, false); assert.ok(only.visibleLengthCss > 0);
  const input = state([inset, { ...inset, id: 'TIE' }]);
  assert.equal(chooseBenchmarkLineEdit(input, view).original.id, 'TIE');
});
