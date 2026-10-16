/** Authored SFNT programs only; no installed font bytes belong in tracked tests. */
import { createRequire } from 'node:module';
import type { NativeFontMetrics } from '../../src/core/text-metrics';
import type { PdfFontFace } from '../../src/io/pdf-fonts';
import { fontTable, nativeFontFixture } from './native-font-fixture';

const require = createRequire(import.meta.url);
const { parseFontMetrics } = require('../../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): NativeFontMetrics };

export interface PdfFontFixtureOptions {
  family?: string;
  bold?: boolean;
  italic?: boolean;
  fsType?: number;
  alias?: boolean;
  postscriptName?: string;
  /** Scalar mapped to the authored fifth glyph, for script-specific output tests. */
  unicodeCodePoint?: number;
}

/** Standalone glyf SFNT with real nameID6, native widths/bearings and a supplementary scalar. */
export function pdfFontFixture(options: PdfFontFixtureOptions = {}): Omit<PdfFontFace, 'key'> {
  const family = options.family ?? 'Arial', bold = options.bold ?? false, italic = options.italic ?? false;
  const source = nativeFontFixture({ family, bold, italic, fsType: options.fsType ?? 8, format12: !options.alias, rangeOffset: options.alias });
  if (options.alias) {
    const cmap = fontTable(source, 'cmap').offset;
    source.writeUInt16BE(1, cmap + source.readUInt32BE(cmap + 8) + 42);
  } else {
    const cmap = fontTable(source, 'cmap').offset, supplementary = cmap + source.readUInt32BE(cmap + 16) + 40;
    source.writeUInt32BE(options.unicodeCodePoint ?? 0x20000, supplementary); source.writeUInt32BE(options.unicodeCodePoint ?? 0x20000, supplementary + 4);
  }
  const italicAngle = italic ? -12 : 0;
  source.writeInt32BE(italicAngle * 65536, fontTable(source, 'post').offset + 4);
  const postscriptName = options.postscriptName ?? `JCad${family.replace(/[^A-Za-z0-9]/g, '')}${bold ? 'Bold' : 'Regular'}${italic ? 'Italic' : ''}`;
  const tables = new Map<string, Buffer>();
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const record = 12 + i * 16, offset = source.readUInt32BE(record + 8), length = source.readUInt32BE(record + 12);
    tables.set(source.toString('ascii', record, record + 4), Buffer.from(source.subarray(offset, offset + length)));
  }
  const entries = [[1, family], [2, bold ? italic ? 'Bold Italic' : 'Bold' : italic ? 'Italic' : 'Regular'], [6, postscriptName]] as const;
  const values = entries.map(([, value]) => Buffer.from(value, 'utf16le').swap16()), storage = 6 + entries.length * 12;
  const name = Buffer.alloc(storage + values.reduce((sum, value) => sum + value.length, 0));
  name.writeUInt16BE(entries.length, 2); name.writeUInt16BE(storage, 4);
  let offset = 0;
  entries.forEach(([id], i) => {
    const record = 6 + i * 12;
    [3, 1, 0x0409, id, values[i]!.length, offset].forEach((value, part) => name.writeUInt16BE(value, record + part * 2));
    values[i]!.copy(name, storage + offset); offset += values[i]!.length;
  });
  tables.set('name', name); tables.get('head')!.writeUInt32BE(0, 8);
  const checksum = (bytes: Buffer) => {
    let sum = 0;
    for (let at = 0; at < bytes.length; at += 4) {
      let word = 0;
      for (let part = 0; part < 4; part++) word = (word * 256 + (bytes[at + part] ?? 0)) >>> 0;
      sum = (sum + word) >>> 0;
    }
    return sum;
  };
  const bytes = Buffer.alloc(12 + tables.size * 16 + [...tables.values()].reduce((sum, value) => sum + Math.ceil(value.length / 4) * 4, 0));
  source.copy(bytes, 0, 0, 12); offset = 12 + tables.size * 16;
  [...tables].forEach(([tag, data], i) => {
    const record = 12 + i * 16;
    bytes.write(tag, record, 'ascii'); bytes.writeUInt32BE(checksum(data), record + 4); bytes.writeUInt32BE(offset, record + 8); bytes.writeUInt32BE(data.length, record + 12);
    data.copy(bytes, offset); offset += Math.ceil(data.length / 4) * 4;
  });
  bytes.writeUInt32BE((0xb1b0afba - checksum(bytes)) >>> 0, fontTable(bytes, 'head').offset + 8);
  return { bytes, metrics: parseFontMetrics(bytes), postscriptName, ascender: 1000, descender: -200, italicAngle, weight: bold ? 700 : 400, isFixedPitch: false, os2Version: 2 };
}
