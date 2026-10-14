import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeFallbackRestoration } from './gpu-fallback-restoration.mjs';

const image = (data, width = data.length / 4, height = 1) => ({ width, height, data: Uint8Array.from(data) });

test('exact native restoration requires zero signed fallback change', () => {
  const native = image([12, 34, 56, 255]), fallback = image([20, 40, 60, 255]);
  const result = analyzeFallbackRestoration(native, native, fallback, fallback);
  assert.deepEqual(result.nativeCanvas, { rawChangedPixels: 0, maxChannelChange: 0 });
  assert.deepEqual(result.fallback, { rawChangedPixels: 0, maxChannelChange: 0 });
  assert.deepEqual(result.differential, { mismatchedChannels: 0, mismatchedPixels: 0, maxChannelMismatch: 0 });
  assert.equal(result.nativeReferenceOutcome, 'exact'); assert.equal(result.differentialMatches, true);
  const changedFallback = analyzeFallbackRestoration(native, native, fallback, image([21, 40, 60, 255]));
  assert.equal(changedFallback.differentialMatches, false);
  assert.equal(changedFallback.nativeReferenceOutcome, 'exact');
});

test('matched nonzero native changes remain inconclusive while reporting exact signed agreement', () => {
  const before = image([0, 255, 10, 0, 30, 40, 50, 255]);
  const after = image([255, 0, 20, 255, 30, 40, 50, 255]);
  const originalBefore = before.data.slice(), originalAfter = after.data.slice();
  const result = analyzeFallbackRestoration(before, after, before, after);
  assert.deepEqual(result.nativeCanvas, { rawChangedPixels: 1, maxChannelChange: 255 });
  assert.deepEqual(result.fallback, result.nativeCanvas);
  assert.equal(result.nativeReferenceOutcome, 'inconclusive'); assert.equal(result.differentialMatches, true);
  assert.deepEqual(before.data, originalBefore); assert.deepEqual(after.data, originalAfter);
});

test('opposite signed changes cannot pass as equal absolute changes', () => {
  const result = analyzeFallbackRestoration(image([20, 0, 0, 255]), image([10, 0, 0, 255]), image([20, 0, 0, 255]), image([30, 0, 0, 255]));
  assert.equal(result.nativeCanvas.maxChannelChange, 10); assert.equal(result.fallback.maxChannelChange, 10);
  assert.deepEqual(result.differential, { mismatchedChannels: 1, mismatchedPixels: 1, maxChannelMismatch: 20 });
  assert.equal(result.differentialMatches, false);
});

test('full-range opposite changes do not wrap through unsigned bytes', () => {
  const result = analyzeFallbackRestoration(image([0, 0, 0, 255]), image([255, 0, 0, 255]), image([255, 0, 0, 255]), image([0, 0, 0, 255]));
  assert.equal(result.differential.maxChannelMismatch, 510); assert.equal(result.differentialMatches, false);
});

test('alpha is compared and multiple channel mismatches count one changed pixel', () => {
  const before = image([10, 20, 30, 255, 40, 50, 60, 255]);
  const after = image([11, 20, 30, 254, 40, 50, 60, 255]);
  const fallbackAfter = image([12, 20, 30, 253, 40, 50, 60, 255]);
  const result = analyzeFallbackRestoration(before, after, before, fallbackAfter);
  assert.deepEqual(result.differential, { mismatchedChannels: 2, mismatchedPixels: 1, maxChannelMismatch: 1 });
  const alphaOnly = analyzeFallbackRestoration(before, before, before, image([10, 20, 30, 254, 40, 50, 60, 255]));
  assert.equal(alphaOnly.differential.mismatchedChannels, 1); assert.equal(alphaOnly.fallback.rawChangedPixels, 1);
});

test('rejects incompatible dimensions, lengths and invalid RGBA channels', () => {
  const valid = image([0, 0, 0, 255, 0, 0, 0, 255]);
  assert.throws(() => analyzeFallbackRestoration(valid, { ...valid, width: 1, height: 2 }, valid, valid), /identical dimensions/);
  assert.throws(() => analyzeFallbackRestoration(valid, { ...valid, data: new Uint8Array(4) }, valid, valid), /byte length/);
  assert.throws(() => analyzeFallbackRestoration({ ...valid, width: 0 }, valid, valid, valid), /positive safe integers/);
  assert.throws(() => analyzeFallbackRestoration(valid, { ...valid, data: [0, 0, 0, 255, 0, 0, 0, -1] }, valid, valid), /integer bytes/);
  assert.throws(() => analyzeFallbackRestoration(valid, { ...valid, data: [0, 0, 0, 255, 0, 0, 0, 256] }, valid, valid), /integer bytes/);
  assert.throws(() => analyzeFallbackRestoration(valid, { ...valid, data: [0, 0, 0, 255, 0, 0, 0, 0.5] }, valid, valid), /integer bytes/);
});

test('ordinary RGBA arrays and PNG-compatible Buffers preserve signed agreement', () => {
  const before = { width: 1, height: 1, data: [20, 30, 40, 255] };
  const after = { width: 1, height: 1, data: [10, 50, 40, 254] };
  const result = analyzeFallbackRestoration(before, after, { ...before, data: Buffer.from(before.data) }, { ...after, data: Buffer.from(after.data) });
  assert.equal(result.differentialMatches, true); assert.equal(result.nativeReferenceOutcome, 'inconclusive');
  assert.deepEqual(result.nativeCanvas, { rawChangedPixels: 1, maxChannelChange: 20 });
});
