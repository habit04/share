/** Authored SFNT programs only; no installed font bytes belong in tracked tests. */
import { createRequire } from 'node:module';
import type { NativeFontMetrics } from '../../src/core/text-metrics';
import type { PdfFontFace } from '../../src/io/pdf-fonts';
import { fontTable, nativeFontFixture, type FvarAxisFixture, type FvarInstanceFixture } from './native-font-fixture';

const require = createRequire(import.meta.url);
const { parseFontMetrics } = require('../../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): NativeFontMetrics };

export interface PdfFontFixtureOptions {
  family?: string;
  subfamily?: string;
  os2Weight?: number;
  /** Variable fixture whose base tables describe the default instance. */
  variable?: boolean;
  variableAxes?: readonly FvarAxisFixture[];
  variableInstances?: readonly FvarInstanceFixture[];
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
  const source = nativeFontFixture({ family, subfamily: options.subfamily, bold, italic, fsType: options.fsType ?? 8, os2Weight: options.os2Weight, format12: !options.alias, rangeOffset: options.alias, variable: options.variable, variableAxes: options.variableAxes, variableInstances: options.variableInstances });
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
  interface NameRecord { platform: number; encoding: number; language: number; id: number; bytes: Buffer }
  const fresh: NameRecord[] = ([[1, family], [2, options.subfamily ?? (bold ? italic ? 'Bold Italic' : 'Bold' : italic ? 'Italic' : 'Regular')], [6, postscriptName]] as const)
    .map(([id, value]) => ({ platform: 3, encoding: 1, language: 0x0409, id, bytes: Buffer.from(value, 'utf16le').swap16() }));
  // Records the rebuilt table does not own (typographic names, and every name ID the fvar
  // table references: axis names and named-instance names) are carried over verbatim, so a
  // variable fixture's name table still resolves the IDs its fvar records point at.
  const carried: NameRecord[] = [], sourceName = tables.get('name')!;
  const sourceCount = sourceName.readUInt16BE(2), sourceStorage = sourceName.readUInt16BE(4);
  for (let i = 0; options.variable && i < sourceCount; i++) {
    const record = 6 + i * 12, id = sourceName.readUInt16BE(record + 6);
    if (id === 1 || id === 2 || id === 6) continue;
    const length = sourceName.readUInt16BE(record + 8), at = sourceStorage + sourceName.readUInt16BE(record + 10);
    carried.push({ platform: sourceName.readUInt16BE(record), encoding: sourceName.readUInt16BE(record + 2), language: sourceName.readUInt16BE(record + 4), id, bytes: Buffer.from(sourceName.subarray(at, at + length)) });
  }
  const records = [...fresh, ...carried], storage = 6 + records.length * 12;
  const name = Buffer.alloc(storage + records.reduce((sum, record) => sum + record.bytes.length, 0));
  name.writeUInt16BE(records.length, 2); name.writeUInt16BE(storage, 4);
  let offset = 0;
  records.forEach((entry, i) => {
    const record = 6 + i * 12;
    [entry.platform, entry.encoding, entry.language, entry.id, entry.bytes.length, offset].forEach((value, part) => name.writeUInt16BE(value, record + part * 2));
    entry.bytes.copy(name, storage + offset); offset += entry.bytes.length;
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
