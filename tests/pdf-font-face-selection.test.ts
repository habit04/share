import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fontCollection, nativeFontFixture } from './helpers/native-font-fixture';
import { pdfFontFixture } from './helpers/pdf-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';

type Request = { font: string; family?: string; bold?: boolean; italic?: boolean };
type Options = { fontsDirectory?: string };
type Metrics = NativeFontMetrics & { resolvedFilename: string; faceIndex?: number };
type Data = { bytes: Uint8Array; metrics: Metrics };
type Face = Data & { postscriptName: string; weight: number; os2Version: number };
const require = createRequire(import.meta.url);
const { readWindowsFontData, readWindowsFontMetrics } = require('../electron/font-metrics.cjs') as {
  readWindowsFontData(request: Request, options?: Options): Promise<Data>;
  readWindowsFontMetrics(request: Request, options?: Options): Promise<Metrics>;
};
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: Request, options?: Options): Promise<Face>;
};
const { extractTtcFace } = require('../electron/ttc-extract.cjs') as {
  extractTtcFace(input: Uint8Array, faceIndex?: number): Buffer;
};
const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-face-selection-'));
  roots.push(directory); return directory;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-face-selection-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected face selection test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

/**
 * One collection whose faces differ by style and family: face 0 is the regular
 * face of family A, face 1 its bold face, face 2 the regular face of family B.
 * Capital height and win descent differ per face so metrics prove their origin.
 */
function metricsCollection(): Buffer {
  return fontCollection(
    nativeFontFixture({ family: 'JCad Fixture', capitalHeight: 700, winDescent: 240 }),
    nativeFontFixture({ family: 'JCad Fixture', bold: true, capitalHeight: 760, winDescent: 241 }),
    nativeFontFixture({ family: 'Second Fixture', capitalHeight: 820, winDescent: 242 }),
  );
}
async function metricsDirectory(bytes: Buffer): Promise<string> {
  const fontsDirectory = await privateDirectory();
  await fs.writeFile(path.join(fontsDirectory, 'multi.ttc'), bytes);
  return fontsDirectory;
}

describe('collection face selection for installed-font metrics', () => {
  it('selects the bold face of the requested family instead of failing the style check', async () => {
    const fontsDirectory = await metricsDirectory(metricsCollection());
    const metrics = await readWindowsFontMetrics({ font: 'multi.ttc', family: 'JCad Fixture', bold: true }, { fontsDirectory });
    expect(metrics).toMatchObject({ faceIndex: 1, family: 'JCad Fixture', subfamily: 'Bold', bold: true, italic: false, capitalHeight: 760, winDescent: 241, resolvedFilename: 'multi.ttc' });
  });
  it('selects the bold face when style is requested without a family', async () => {
    const fontsDirectory = await metricsDirectory(metricsCollection());
    const metrics = await readWindowsFontMetrics({ font: 'multi.ttc', bold: true }, { fontsDirectory });
    expect(metrics).toMatchObject({ faceIndex: 1, bold: true, capitalHeight: 760 });
  });
  it('selects the face of a different family in the same collection', async () => {
    const fontsDirectory = await metricsDirectory(metricsCollection());
    const metrics = await readWindowsFontMetrics({ font: 'multi.ttc', family: 'Second Fixture' }, { fontsDirectory });
    expect(metrics).toMatchObject({ faceIndex: 2, family: 'Second Fixture', subfamily: 'Regular', bold: false, capitalHeight: 820, winDescent: 242 });
  });
  it('keeps face 0 when neither family nor style is requested', async () => {
    const fontsDirectory = await metricsDirectory(metricsCollection());
    expect(await readWindowsFontMetrics({ font: 'multi.ttc' }, { fontsDirectory })).toMatchObject({ faceIndex: 0, family: 'JCad Fixture', capitalHeight: 700 });
    expect(await readWindowsFontMetrics({ font: 'multi.ttc', family: 'JCad Fixture' }, { fontsDirectory })).toMatchObject({ faceIndex: 0, subfamily: 'Regular', capitalHeight: 700 });
  });
  it('still fails explicitly when the requested family has no face with the requested style', async () => {
    const fontsDirectory = await metricsDirectory(metricsCollection());
    await expect(readWindowsFontMetrics({ font: 'multi.ttc', family: 'Second Fixture', bold: true }, { fontsDirectory })).rejects.toThrow('style does not match');
    await expect(readWindowsFontMetrics({ font: 'multi.ttc', family: 'JCad Fixture', italic: true }, { fontsDirectory })).rejects.toThrow('style does not match');
  });
  it('still fails explicitly when no face carries the requested family', async () => {
    const fontsDirectory = await metricsDirectory(metricsCollection());
    await expect(readWindowsFontMetrics({ font: 'multi.ttc', family: 'Missing Fixture' }, { fontsDirectory })).rejects.toThrow('family does not match');
  });
  it('leaves standalone files on face 0', async () => {
    const fontsDirectory = await privateDirectory();
    await fs.writeFile(path.join(fontsDirectory, 'single.ttf'), nativeFontFixture({ bold: true, capitalHeight: 760 }));
    expect(await readWindowsFontMetrics({ font: 'single.ttf', bold: true }, { fontsDirectory })).toMatchObject({ faceIndex: 0, bold: true, capitalHeight: 760 });
    const data = await readWindowsFontData({ font: 'single.ttf' }, { fontsDirectory });
    expect(data.metrics.faceIndex).toBe(0);
  });
});

describe('collection face selection for PDF embedding', () => {
  const regular = () => Buffer.from(pdfFontFixture({ family: 'Arial', fsType: 8 }).bytes);
  const bold = (fsType = 8) => Buffer.from(pdfFontFixture({ family: 'Arial', bold: true, fsType }).bytes);
  async function pdfDirectory(bytes: Buffer): Promise<string> {
    const fontsDirectory = await privateDirectory();
    await fs.writeFile(path.join(fontsDirectory, 'arial.ttc'), bytes);
    return fontsDirectory;
  }
  it('embeds the selected bold face, with metrics from that same face', async () => {
    const bytes = fontCollection(regular(), bold()), fontsDirectory = await pdfDirectory(bytes);
    const face = await readWindowsPdfFont({ font: 'arial.ttc', family: 'Arial', bold: true }, { fontsDirectory });
    expect(face.bytes).toEqual(extractTtcFace(bytes, 1));
    expect(face.bytes).not.toEqual(extractTtcFace(bytes, 0));
    expect(face).toMatchObject({ postscriptName: 'JCadArialBold', weight: 700 });
    expect(face.metrics).toMatchObject({ faceIndex: 1, bold: true, family: 'Arial' });
  });
  it('keeps embedding face 0 when no style is requested', async () => {
    const bytes = fontCollection(regular(), bold()), fontsDirectory = await pdfDirectory(bytes);
    const face = await readWindowsPdfFont({ font: 'arial.ttc', family: 'Arial' }, { fontsDirectory });
    expect(face.bytes).toEqual(extractTtcFace(bytes, 0));
    expect(face).toMatchObject({ postscriptName: 'JCadArialRegular', weight: 400 });
    expect(face.metrics.faceIndex).toBe(0);
  });
  it('checks embedding permissions on the selected face, not face 0', async () => {
    const restrictedBold = fontCollection(regular(), bold(2)), fontsDirectory = await pdfDirectory(restrictedBold);
    await expect(readWindowsPdfFont({ font: 'arial.ttc', family: 'Arial', bold: true }, { fontsDirectory })).rejects.toThrow('restricted');
  });
  it('does not let a restricted face 0 block an editable selected face', async () => {
    const bytes = fontCollection(Buffer.from(pdfFontFixture({ family: 'Arial', fsType: 2 }).bytes), bold()), fontsDirectory = await pdfDirectory(bytes);
    const face = await readWindowsPdfFont({ font: 'arial.ttc', family: 'Arial', bold: true }, { fontsDirectory });
    expect(face.postscriptName).toBe('JCadArialBold');
    await expect(readWindowsPdfFont({ font: 'arial.ttc', family: 'Arial' }, { fontsDirectory })).rejects.toThrow('restricted');
  });
});
