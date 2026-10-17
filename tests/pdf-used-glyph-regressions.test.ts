import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FontMetricsRequest, NativeFontMetrics } from '../src/core/text-metrics';
import { fontCollection, fontTable, nativeFontFixture, compositeGlyph } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';

const require = createRequire(import.meta.url);
type Metrics = NativeFontMetrics & { faceIndex: number; resolvedFilename: string };
type Face = { bytes: Uint8Array; metrics: Metrics; postscriptName: string };
type Options = { fontsDirectory?: string };
const { parseFontMetrics, readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  parseFontMetrics(bytes: Uint8Array, options?: { usedCodepoints?: Iterable<number> }): NativeFontMetrics;
  readWindowsFontMetrics(request: FontMetricsRequest, options?: Options): Promise<Metrics>;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: FontMetricsRequest, options?: Options): Promise<Face>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(input: Uint8Array, faceIndex: number): Buffer;
};

const roots: string[] = [];
async function fontsDirectory(bytes: Buffer, filename = 'multi.ttc'): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-used-face-'));
  roots.push(directory);
  await fs.writeFile(path.join(directory, filename), bytes);
  return directory;
}
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    const relative = path.relative(tmpdir(), directory);
    if (!relative.startsWith('jcad-used-face-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected font fixture cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  }
});

/** Each face maps the same supplementary scalar to a different authored glyph. */
function face(family: string, bold: boolean, supplementaryGlyph: 3 | 4, fsType = 8): Buffer {
  const bytes = Buffer.from(pdfFontFixture({ family, bold, fsType }).bytes);
  const cmap = fontTable(bytes, 'cmap').offset;
  const format12 = cmap + bytes.readUInt32BE(cmap + 16);
  expect(bytes.readUInt16BE(format12)).toBe(12);
  expect(bytes.readUInt32BE(format12 + 40)).toBe(0x20000);
  bytes.writeUInt32BE(supplementaryGlyph, format12 + 48);
  // The TTC extractor recomputes checksums instead of trusting the input records.
  return bytes;
}
const usedCodepoints = [0x20000];

describe('used glyphs and selected collection faces compose', () => {
  it('validates the selected bold face cmap and embeds that exact whole face', async () => {
    const collection = fontCollection(face('Arial', false, 4, 2), face('Arial', true, 3, 0x0108), face('Other Fixture', false, 4));
    const directory = await fontsDirectory(collection);
    const result = await readWindowsPdfFont({ font: 'multi.ttc', family: 'Arial', bold: true, usedCodepoints }, { fontsDirectory: directory });
    expect(result.metrics).toMatchObject({ faceIndex: 1, family: 'Arial', bold: true, fsType: 0x0108 });
    expect(result.metrics.groups).toContainEqual([0x20000, 0x20000, 3]);
    expect(result.metrics.glyphBoundsKnown?.[2]).toBe(true); // Always-seeded capital A.
    expect(result.metrics.glyphBoundsKnown?.[3]).toBe(true); // Selected face's mapping.
    expect(result.metrics.glyphBoundsKnown?.[4]).toBe(false); // Face 0's mapping is not used.
    expect(Buffer.from(result.bytes)).toEqual(extractTtcFace(collection, 1));
    expect(Buffer.from(result.bytes)).not.toEqual(extractTtcFace(collection, 0));
    expect(result.postscriptName).toBe('JCadArialBold');
    // A used set does not enable subsetting when the selected face forbids it.
    expect(result.bytes.byteLength).toBe(extractTtcFace(collection, 1).byteLength);
  });

  it('validates a cross-family nonzero face instead of using the first family cmap', async () => {
    const collection = fontCollection(face('Arial', false, 3), face('Arial', true, 3), face('Other Fixture', false, 4));
    const directory = await fontsDirectory(collection);
    const result = await readWindowsPdfFont({ font: 'multi.ttc', family: 'Other Fixture', usedCodepoints }, { fontsDirectory: directory });
    expect(result.metrics).toMatchObject({ faceIndex: 2, family: 'Other Fixture', bold: false });
    expect(result.metrics.groups).toContainEqual([0x20000, 0x20000, 4]);
    expect(result.metrics.glyphBoundsKnown?.[4]).toBe(true);
    expect(result.metrics.glyphBoundsKnown?.[3]).toBe(false);
    expect(Buffer.from(result.bytes)).toEqual(extractTtcFace(collection, 2));
    expect(result.postscriptName).toBe('JCadOtherFixtureRegular');
  });

  it('retains regular-face preference when a used set is supplied and bold is first', async () => {
    const collection = fontCollection(face('Arial', true, 3), face('Arial', false, 4));
    const directory = await fontsDirectory(collection);
    const result = await readWindowsPdfFont({ font: 'multi.ttc', family: 'Arial', usedCodepoints }, { fontsDirectory: directory });
    expect(result.metrics).toMatchObject({ faceIndex: 1, bold: false });
    expect(result.metrics.glyphBoundsKnown?.[4]).toBe(true);
    expect(result.metrics.glyphBoundsKnown?.[3]).toBe(false);
  });

  it('keeps metadata reads eager on the selected face even with caller used glyphs', async () => {
    const collection = fontCollection(face('Arial', false, 4), face('Arial', true, 3));
    const directory = await fontsDirectory(collection);
    const metrics = await readWindowsFontMetrics({ font: 'multi.ttc', family: 'Arial', bold: true, usedCodepoints }, { fontsDirectory: directory });
    expect(metrics).toMatchObject({ faceIndex: 1, bold: true });
    expect(metrics.glyphBoundsKnown?.every(Boolean)).toBe(true);
  });

  it.each([
    [1, 'Arial', true, 2, 'restricted'],
    [1, 'Arial', true, 4, 'read-only'],
    [1, 'Arial', true, 0x0208, 'bitmap-only'],
    [2, 'Other Fixture', false, 2, 'restricted'],
  ] as const)('retains face %i permission refusal for %s, bold=%s, fsType=%i', async (index, family, bold, fsType, problem) => {
    const collection = fontCollection(face('Arial', false, 4), face('Arial', true, 3, index === 1 ? fsType : 8), face('Other Fixture', false, 4, index === 2 ? fsType : 8));
    const directory = await fontsDirectory(collection);
    await expect(readWindowsPdfFont({ font: 'multi.ttc', family, bold, usedCodepoints }, { fontsDirectory: directory })).rejects.toThrow(problem);
  });
});

describe('used sets retain bitmap and unknown-origin safeguards', () => {
  it.each([{ used: [] }, { used: [0x41] }, { used: [0x42] }])('does not admit a bitmap-covered capital A with used set %j', async ({ used }) => {
    const bytes = nativeFontFixture({ bitmapGlyphRange: [2, 3] });
    expect(() => parseFontMetrics(bytes, { usedCodepoints: used })).toThrow(/capital A glyph must have a known origin/);
    const directory = await fontsDirectory(bytes, 'bitmap.ttf');
    await expect(readWindowsPdfFont({ font: 'bitmap.ttf', family: 'JCad Fixture', usedCodepoints: used }, { fontsDirectory: directory })).rejects.toThrow(/capital A glyph must have a known origin/);
  });

  it('keeps a bitmap-covered used glyph unknown when capital A remains eligible', () => {
    const bytes = nativeFontFixture({ bitmapGlyphRange: [3, 4] });
    const metrics = parseFontMetrics(bytes, { usedCodepoints: [0x41, 0x42] });
    expect(metrics.glyphBoundsKnown?.[2]).toBe(true);
    expect(metrics.glyphBoundsKnown?.[3]).toBe(false);
    expect(metrics.glyphBoundsKnown?.[4]).toBe(false);
  });

  it('does not turn unresolved used-composite phantom origins into trusted bounds', () => {
    const shiftedOwner = compositeGlyph(2, [-10, 0, 630, 730], 0x0202);
    shiftedOwner.writeInt8(10, 14);
    const bytes = nativeFontFixture({ extraGlyphs: [shiftedOwner], cmapExtra: [[0x4e2d, 5]] });
    const metrics = parseFontMetrics(bytes, { usedCodepoints: [0x4e2d] });
    expect(metrics.glyphBoundsKnown?.[2]).toBe(true);
    expect(metrics.glyphBoundsKnown?.[5]).toBe(false);
    expect(metrics.glyphBounds[5]).toEqual([-10, 0, 630, 730]);
  });

  it('retains the empty space glyph while always validating capital A', () => {
    const metrics = parseFontMetrics(nativeFontFixture(), { usedCodepoints: [] });
    expect(metrics.glyphBoundsKnown?.[1]).toBe(true);
    expect(metrics.glyphBounds[1]).toEqual([0, 0, 0, 0]);
    expect(metrics.glyphBoundsKnown?.[2]).toBe(true);
    expect(metrics.glyphBoundsKnown?.[3]).toBe(false);
  });
});
