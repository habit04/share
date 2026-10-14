import assert from 'node:assert/strict';

/** Compare cross-state changes, including their signs, with no pixel tolerance.
 * A changed native Canvas reference is inconclusive about exact restoration;
 * identical signed changes still establish that the fallback followed that reference.
 * Absolute Canvas/fallback image parity must be checked separately by the caller.
 */
export function analyzeFallbackRestoration(canvasBefore, canvasAfter, fallbackBefore, fallbackAfter) {
  const images = [canvasBefore, canvasAfter, fallbackBefore, fallbackAfter];
  const first = images[0];
  assert.ok(first && Number.isSafeInteger(first.width) && first.width > 0 && Number.isSafeInteger(first.height) && first.height > 0, 'RGBA image dimensions must be positive safe integers');
  const length = first.width * first.height * 4;
  assert.ok(Number.isSafeInteger(length), 'RGBA image byte length must be a safe integer');
  const data = images.map((image) => {
    assert.ok(image && image.width === first.width && image.height === first.height, 'All restoration images must have identical dimensions');
    assert.ok(Array.isArray(image.data) || image.data instanceof Uint8Array || image.data instanceof Uint8ClampedArray, 'Restoration images require RGBA byte arrays');
    assert.equal(image.data.length, length, 'RGBA byte length must match the image dimensions');
    // Uint8 arrays (including PNG Buffers) already guarantee byte validity.
    if (Array.isArray(image.data)) for (const value of image.data) assert.ok(Number.isInteger(value) && value >= 0 && value <= 255, 'RGBA channels must be integer bytes');
    return image.data;
  });
  const nativeCanvas = { rawChangedPixels: 0, maxChannelChange: 0 };
  const fallback = { rawChangedPixels: 0, maxChannelChange: 0 };
  const differential = { mismatchedChannels: 0, mismatchedPixels: 0, maxChannelMismatch: 0 };
  for (let pixel = 0; pixel < length; pixel += 4) {
    let nativeChanged = false, fallbackChanged = false, mismatch = false;
    for (let channel = 0; channel < 4; channel++) {
      const index = pixel + channel;
      // Numeric subtraction preserves the signed Int16 range [-255, 255].
      // Storing these in Uint8 arrays would wrap opposite changes into false matches.
      const nativeDelta = data[1][index] - data[0][index];
      const fallbackDelta = data[3][index] - data[2][index];
      nativeChanged ||= nativeDelta !== 0;
      fallbackChanged ||= fallbackDelta !== 0;
      nativeCanvas.maxChannelChange = Math.max(nativeCanvas.maxChannelChange, Math.abs(nativeDelta));
      fallback.maxChannelChange = Math.max(fallback.maxChannelChange, Math.abs(fallbackDelta));
      if (nativeDelta !== fallbackDelta) {
        mismatch = true;
        differential.mismatchedChannels++;
        differential.maxChannelMismatch = Math.max(differential.maxChannelMismatch, Math.abs(nativeDelta - fallbackDelta));
      }
    }
    if (nativeChanged) nativeCanvas.rawChangedPixels++;
    if (fallbackChanged) fallback.rawChangedPixels++;
    if (mismatch) differential.mismatchedPixels++;
  }
  return { nativeCanvas, fallback, differential, differentialMatches: differential.mismatchedChannels === 0, nativeReferenceOutcome: nativeCanvas.rawChangedPixels === 0 ? 'exact' : 'inconclusive' };
}
