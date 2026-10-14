import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchesBenchmarkFallbackReason, mixedSchematicFallbackReasons } from './gpu-benchmark-fallback.mjs';
const expected = 'Curve stroke overlap or precision margin requires Canvas rendering';
const observed = [
  expected + ' (b5)',
  'Unsupported Canvas stroke construction: native float curve parameters exceed precision budget',
  'Unsupported Canvas stroke construction: native float curve oval topology is unproved',
  'Unsupported Canvas stroke construction: native float curve radius is unproved',
];
test('original mixed drawing accepts its four observed native safety causes', () => {
  for (const reason of observed) assert.equal(matchesBenchmarkFallbackReason('mixed-schematic', expected, reason), true, reason);
});
test('mixed safety causes cannot conceal driver, unsupported, altered or unknown errors', () => {
  for (const reason of ['Device unavailable', 'Stroke geometry exceeds prototype budget', expected, expected + ' (b6)', expected + ' (b5) extra', 'Unsupported Canvas stroke construction:', 'Unsupported Canvas stroke construction: native float arc connection is unproved', ...observed.flatMap(value => ['driver failure: ' + value, value + ' ', value.toLowerCase()])]) {
    assert.equal(matchesBenchmarkFallbackReason('mixed-schematic', expected, reason), false, reason);
  }
});
test('native curve alternatives apply only to the original mixed fixture classification', () => {
  for (const fixture of ['dense-lines', 'compound-tags', 'mixed-schematic-new']) for (const reason of observed.slice(1)) assert.equal(matchesBenchmarkFallbackReason(fixture, expected, reason), false);
});
test('a changed expected baseline cannot acquire the mixed safety exceptions', () => {
  for (const baseline of [null, undefined, '', expected + ' ', observed[1], 7]) for (const reason of observed) assert.equal(matchesBenchmarkFallbackReason('mixed-schematic', baseline, reason), false);
});
test('nonstrings are refused without coercing caller-owned data', () => {
  for (const reason of [null, undefined, 7, Symbol('reason'), { toString() { throw new Error('Must not coerce'); } }]) assert.equal(matchesBenchmarkFallbackReason('mixed-schematic', expected, reason), false);
});
test('ordinary fixtures keep their existing expected-message contract', () => {
  assert.equal(matchesBenchmarkFallbackReason('curves', 'native float arc connection is unproved', 'Unsupported Canvas stroke construction: native float arc connection is unproved (P)'), true);
  assert.equal(matchesBenchmarkFallbackReason('curves', 'native float arc connection is unproved', observed[1]), false);
  assert.equal(matchesBenchmarkFallbackReason('compound-dense', 'Stroke geometry exceeds prototype budget', 'Stroke geometry exceeds prototype budget'), true);
});
test('the mixed policy is fixed to the independently recorded four-message inventory', () => {
  assert.deepEqual(mixedSchematicFallbackReasons, observed); assert.equal(Object.isFrozen(mixedSchematicFallbackReasons), true);
});
