import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { nativeFontFixture, fontTable } from './helpers/native-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';
import { PdfFontRegistry, type PdfFontFace } from '../src/io/pdf-fonts';

const require = createRequire(import.meta.url);
const { parseFontMetrics } = require('../electron/font-metrics.cjs') as { parseFontMetrics(bytes: Uint8Array): NativeFontMetrics };

function replaceTable(source: Buffer, tag: string, replacement: Buffer): Buffer {
  const tables: { tag: string; bytes: Buffer }[] = [];
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const at = 12 + i * 16, name = source.toString('ascii', at, at + 4), start = source.readUInt32BE(at + 8), length = source.readUInt32BE(at + 12);
    tables.push({ tag: name, bytes: name === tag ? replacement : Buffer.from(source.subarray(start, start + length)) });
  }
  tables.find((table) => table.tag === 'head')!.bytes.writeUInt32BE(0, 8);
  const checksum = (bytes: Buffer) => { let sum = 0; for (let i = 0; i < bytes.length; i += 4) { let word = 0; for (let j = 0; j < 4; j++) word = (word * 256 + (bytes[i + j] ?? 0)) >>> 0; sum = (sum + word) >>> 0; } return sum; };
  const bytes = Buffer.alloc(12 + tables.length * 16 + tables.reduce((n, table) => n + Math.ceil(table.bytes.length / 4) * 4, 0));
  source.copy(bytes, 0, 0, 12);
  let offset = 12 + tables.length * 16;
  tables.forEach((table, i) => { const at = 12 + i * 16; bytes.write(table.tag, at, 'ascii'); bytes.writeUInt32BE(checksum(table.bytes), at + 4); bytes.writeUInt32BE(offset, at + 8); bytes.writeUInt32BE(table.bytes.length, at + 12); table.bytes.copy(bytes, offset); offset += Math.ceil(table.bytes.length / 4) * 4; });
  bytes.writeUInt32BE((0xb1b0afba - checksum(bytes)) >>> 0, fontTable(bytes, 'head').offset + 8);
  return bytes;
}
function nameTable(postscriptName: string): Buffer {
  const entries = [[1, 'JCad Fixture'], [2, 'Regular'], [6, postscriptName]] as const;
  const strings = entries.map(([, value]) => Buffer.from(value, 'utf16le').swap16()), storage = 6 + entries.length * 12;
  const data = Buffer.alloc(storage + strings.reduce((n, value) => n + value.length, 0));
  data.writeUInt16BE(entries.length, 2); data.writeUInt16BE(storage, 4);
  let offset = 0;
  entries.forEach(([id], i) => { const at = 6 + i * 12; data.writeUInt16BE(3, at); data.writeUInt16BE(1, at + 2); data.writeUInt16BE(0x409, at + 4); data.writeUInt16BE(id, at + 6); data.writeUInt16BE(strings[i]!.length, at + 8); data.writeUInt16BE(offset, at + 10); strings[i]!.copy(data, storage + offset); offset += strings[i]!.length; });
  return data;
}
function face(options: { key?: string; fsType?: number; version?: number } = {}): PdfFontFace {
  let bytes = nativeFontFixture({ fsType: options.fsType ?? 8, format12: true, rangeOffset: false });
  if (options.version !== undefined) bytes.writeUInt16BE(options.version, fontTable(bytes, 'OS/2').offset);
  const cmap = fontTable(bytes, 'cmap').offset, sub = cmap + bytes.readUInt32BE(cmap + 16);
  bytes.writeUInt32BE(0x20000, sub + 40); bytes.writeUInt32BE(0x20000, sub + 44);
  bytes = replaceTable(bytes, 'name', nameTable('JCadFixture'));
  const metrics = parseFontMetrics(bytes);
  return { key: options.key ?? 'fixture', bytes, metrics, postscriptName: 'JCadFixture', ascender: 1000, descender: -200, italicAngle: 0, weight: 400, isFixedPitch: false, os2Version: options.version ?? 2 };
}

describe('restricted-mode PdfFontRegistry admission (12.4)', () => {
  it('ordinary mode still refuses a preview/print face (control)', () => {
    const registry = new PdfFontRegistry([face({ fsType: 4 })]);
    expect(registry.rejections.get('fixture')).toContain('read-only PDF');
    expect(registry.previewPrintKeys).toEqual([]);
  });

  it('restricted mode admits a preview/print face and records its key from the program fsType', () => {
    const registry = new PdfFontRegistry([face({ fsType: 4, version: 4 })], { restricted: true });
    expect(registry.rejections.has('fixture')).toBe(false);
    expect(registry.previewPrintKeys).toEqual(['fixture']);
    expect(registry.face('fixture')).toBeDefined();
    expect(registry.encode('fixture', 'A')).not.toBeNull();
  });

  it('restricted mode keeps the OS/2 v0-2 least-restrictive precedence (fsType 6 at v2)', () => {
    const registry = new PdfFontRegistry([face({ fsType: 6, version: 2 })], { restricted: true });
    expect(registry.rejections.has('fixture')).toBe(false);
    expect(registry.previewPrintKeys).toEqual(['fixture']);
  });

  it('restricted mode admits an editable face WITHOUT recording it as preview/print', () => {
    const registry = new PdfFontRegistry([face({ fsType: 8 })], { restricted: true });
    expect(registry.rejections.has('fixture')).toBe(false);
    expect(registry.previewPrintKeys).toEqual([]);
  });

  it.each([[2, 'restricted'], [0x0204, 'bitmap-only'], [0x0200, 'bitmap-only'], [1, 'reserved'], [0x0010, 'reserved']])(
    'restricted mode still refuses fsType %i', (fsType, reason) => {
      const registry = new PdfFontRegistry([face({ fsType, version: 4 })], { restricted: true });
      expect(registry.rejections.get('fixture')).toContain(reason);
      expect(registry.previewPrintKeys).toEqual([]);
    });

  it('restricted mode still refuses conflicting permissions at OS/2 v3+', () => {
    const registry = new PdfFontRegistry([face({ fsType: 10, version: 3 })], { restricted: true });
    expect(registry.rejections.get('fixture')).toContain('conflicting');
    expect(registry.previewPrintKeys).toEqual([]);
  });

  it('mixed restricted registry records only the preview/print faces', () => {
    const registry = new PdfFontRegistry([
      face({ key: 'editable', fsType: 8 }),
      face({ key: 'preview', fsType: 4, version: 4 }),
      face({ key: 'blocked', fsType: 2, version: 4 }),
    ], { restricted: true });
    expect(registry.previewPrintKeys).toEqual(['preview']);
    expect(registry.rejections.get('blocked')).toContain('restricted');
    expect(registry.face('editable')).toBeDefined();
    expect(registry.face('preview')).toBeDefined();
  });
});
