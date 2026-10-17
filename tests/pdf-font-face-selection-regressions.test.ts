import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fontCollection, fontCollectionV2, fontTable } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';
import type { PdfFontFace } from '../src/io/pdf-fonts';

type Request = { font: string; family?: string; bold?: boolean; italic?: boolean };
type Options = { fontsDirectory?: string };
type Metrics = NativeFontMetrics & { faceIndex?: number };
const require = createRequire(import.meta.url);
const { readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  readWindowsFontMetrics(request: Request, options: Options): Promise<Metrics>;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: Request, options: Options): Promise<Omit<PdfFontFace, 'key'>>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(bytes: Uint8Array, index: number): Buffer;
};

const roots: string[] = [];
async function installFixture(bytes: Buffer): Promise<Options> {
  const fontsDirectory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-face-regression-'));
  roots.push(fontsDirectory);
  await fs.writeFile(path.join(fontsDirectory, 'faces.ttc'), bytes);
  return { fontsDirectory };
}
afterEach(async () => {
  for (const directory of roots.splice(0)) {
    const relative = path.relative(tmpdir(), directory);
    if (!relative.startsWith('jcad-face-regression-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected face regression cleanup path');
    await fs.rm(directory, { recursive: true, force: true });
  }
});

const family = 'Arial';
const request = { font: 'faces.ttc', family };
const face = (bold = false, italic = false, fsType = 8) => Buffer.from(pdfFontFixture({ family, bold, italic, fsType }).bytes);

describe('collection selection does not depend on regular-first file order', () => {
  it('prefers the regular face for family-only metrics requests when bold comes first', async () => {
    const options = await installFixture(fontCollection(face(true), face()));
    expect(await readWindowsFontMetrics(request, options)).toMatchObject({ faceIndex: 1, bold: false, italic: false, subfamily: 'Regular' });
  });

  it('embeds the regular face for family-only PDF requests when bold comes first', async () => {
    const bytes = fontCollection(face(true), face()), options = await installFixture(bytes);
    const embedded = await readWindowsPdfFont(request, options);
    expect(embedded.metrics).toMatchObject({ faceIndex: 1, bold: false, italic: false });
    expect(embedded.postscriptName).toBe('JCadArialRegular');
    expect(embedded.bytes).toEqual(extractTtcFace(bytes, 1));
  });

  it('preserves face zero when neither family nor style is requested, including a bold first face', async () => {
    const bytes = fontCollection(face(true), face()), options = await installFixture(bytes);
    expect(await readWindowsFontMetrics({ font: 'faces.ttc' }, options)).toMatchObject({ faceIndex: 0, bold: true });
    const embedded = await readWindowsPdfFont({ font: 'faces.ttc' }, options);
    expect(embedded.metrics.faceIndex).toBe(0);
    expect(embedded.bytes).toEqual(extractTtcFace(bytes, 0));
  });
});

describe('collection face flags and permissions come from the selected face', () => {
  it.each([
    { flags: { bold: true }, index: 1, bold: true, italic: false },
    { flags: { italic: true }, index: 2, bold: false, italic: true },
    { flags: { bold: false }, index: 3, bold: false, italic: false },
    { flags: { italic: false }, index: 3, bold: false, italic: false },
  ])('prefers an unstyled unspecified flag for $flags', async ({ flags, index, bold, italic }) => {
    const bytes = fontCollection(face(true, true), face(true), face(false, true), face());
    const options = await installFixture(bytes), wanted = { ...request, ...flags };
    expect(await readWindowsFontMetrics(wanted, options)).toMatchObject({ faceIndex: index, bold, italic });
    const embedded = await readWindowsPdfFont(wanted, options);
    expect(embedded.metrics).toMatchObject({ faceIndex: index, bold, italic });
    expect(embedded.bytes).toEqual(extractTtcFace(bytes, index));
  });

  it.each([
    { bold: false, italic: false, index: 3, name: 'JCadArialRegular' },
    { bold: false, italic: true, index: 2, name: 'JCadArialRegularItalic' },
    { bold: true, italic: false, index: 1, name: 'JCadArialBold' },
    { bold: true, italic: true, index: 0, name: 'JCadArialBoldItalic' },
  ])('selects explicit bold=$bold italic=$italic rather than a partially matching face', async ({ bold, italic, index, name }) => {
    const bytes = fontCollection(face(true, true), face(true), face(false, true), face());
    const options = await installFixture(bytes), wanted = { ...request, bold, italic };
    expect(await readWindowsFontMetrics(wanted, options)).toMatchObject({ faceIndex: index, bold, italic });
    const embedded = await readWindowsPdfFont(wanted, options);
    expect(embedded.metrics).toMatchObject({ faceIndex: index, bold, italic });
    expect(embedded.postscriptName).toBe(name);
    expect(embedded.bytes).toEqual(extractTtcFace(bytes, index));
  });

  it.each([
    { permission: 4, problem: 'preview/print embedding requires a read-only PDF' },
    { permission: 0x0208, problem: 'bitmap-only embedding' },
  ])('refuses selected-face permissions $permission without substituting editable face zero', async ({ permission, problem }) => {
    const bytes = fontCollection(face(), face(true, false, permission)), options = await installFixture(bytes);
    expect(await readWindowsFontMetrics({ ...request, bold: true, italic: false }, options)).toMatchObject({ faceIndex: 1, fsType: permission });
    await expect(readWindowsPdfFont({ ...request, bold: true, italic: false }, options)).rejects.toThrow(problem);
  });

  it('preserves a selected face with no-subsetting permission by embedding its complete program', async () => {
    const bytes = fontCollection(face(), face(true, false, 0x0108)), options = await installFixture(bytes);
    const embedded = await readWindowsPdfFont({ ...request, bold: true, italic: false }, options);
    expect(embedded.metrics).toMatchObject({ faceIndex: 1, fsType: 0x0108 });
    expect(embedded.bytes).toEqual(extractTtcFace(bytes, 1));
  });
});

describe('selected collection faces retain format validation', () => {
  it('does not fall back to regular face zero when the selected bold face has an invalid OS/2 version', async () => {
    const bytes = fontCollection(face(), face(true));
    bytes.writeUInt16BE(6, fontTable(bytes, 'OS/2', 1).offset);
    const options = await installFixture(bytes), wanted = { ...request, bold: true, italic: false };
    await expect(readWindowsFontMetrics(wanted, options)).rejects.toThrow('unsupported OS/2 version');
    await expect(readWindowsPdfFont(wanted, options)).rejects.toThrow('unsupported OS/2 version');
    expect(await readWindowsFontMetrics({ ...request, bold: false, italic: false }, options)).toMatchObject({ faceIndex: 0, bold: false });
  });

  it('selects and embeds a nonzero TTC v2 face with its matching metrics', async () => {
    const bytes = fontCollectionV2(face(), face(false, true)), options = await installFixture(bytes);
    const wanted = { ...request, bold: false, italic: true };
    expect(await readWindowsFontMetrics(wanted, options)).toMatchObject({ faceIndex: 1, bold: false, italic: true });
    const embedded = await readWindowsPdfFont(wanted, options);
    expect(embedded.metrics).toMatchObject({ faceIndex: 1, italic: true });
    expect(embedded.postscriptName).toBe('JCadArialRegularItalic');
    expect(embedded.bytes).toEqual(extractTtcFace(bytes, 1));
  });
});
