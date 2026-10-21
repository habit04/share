import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fontTable, nativeFontFixture } from './helpers/native-font-fixture';
import type { NativeFontMetrics } from '../src/core/text-metrics';

type Request = { font: string; family?: string; bold?: boolean; italic?: boolean; restricted?: boolean };
type Face = { bytes: Uint8Array; metrics: NativeFontMetrics; postscriptName: string; ascender: number; descender: number; italicAngle: number; weight: number; isFixedPitch: boolean; os2Version: number; previewPrint?: boolean };
const require = createRequire(import.meta.url);
const { readWindowsPdfFont } = require('../electron/pdf-font.cjs') as {
  readWindowsPdfFont(request: Request, options?: { fontsDirectory?: string }): Promise<Face>;
};

const roots: string[] = [];
async function privateDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'jcad-restricted-pdf-font-'));
  roots.push(directory); return directory;
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(tmpdir(), root);
    if (!relative.startsWith('jcad-restricted-pdf-font-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unexpected test cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  }
});

function checksum(bytes: Buffer): number {
  let sum = 0;
  for (let offset = 0; offset < bytes.length; offset += 4) {
    let word = 0;
    for (let i = 0; i < 4; i++) word = (word * 256 + (bytes[offset + i] ?? 0)) >>> 0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}
/** Hand-authored standalone glyf program with a chosen OS/2 version + fsType and a real nameID6. */
function pdfFixture(options: { fsType?: number; os2Version?: number } = {}): Buffer {
  const source = nativeFontFixture(), tables = new Map<string, Buffer>();
  for (let i = 0; i < source.readUInt16BE(4); i++) {
    const at = 12 + i * 16, start = source.readUInt32BE(at + 8), length = source.readUInt32BE(at + 12);
    tables.set(source.toString('ascii', at, at + 4), Buffer.from(source.subarray(start, start + length)));
  }
  const os2 = Buffer.alloc(options.os2Version === 5 ? 100 : 96);
  tables.get('OS/2')!.copy(os2); os2.writeUInt16BE(options.os2Version ?? 4, 0); os2.writeUInt16BE(options.fsType ?? 0, 8); os2.writeUInt16BE(400, 4); tables.set('OS/2', os2);
  const name = tables.get('name')!, storage = name.readUInt16BE(4);
  const records = Array.from({ length: name.readUInt16BE(2) }, (_, i) => {
    const at = 6 + i * 12, length = name.readUInt16BE(at + 8), start = storage + name.readUInt16BE(at + 10);
    return { platform: name.readUInt16BE(at), encoding: name.readUInt16BE(at + 2), language: name.readUInt16BE(at + 4), id: name.readUInt16BE(at + 6), bytes: Buffer.from(name.subarray(start, start + length)) };
  });
  records.push({ platform: 3, encoding: 1, language: 0x0409, id: 6, bytes: Buffer.from('JCadFixture-Regular', 'utf16le').swap16() });
  const newStorage = 6 + records.length * 12, names = Buffer.alloc(newStorage + records.reduce((sum, record) => sum + record.bytes.length, 0));
  names.writeUInt16BE(records.length, 2); names.writeUInt16BE(newStorage, 4);
  let position = 0;
  records.forEach((record, i) => {
    const at = 6 + i * 12;
    [record.platform, record.encoding, record.language, record.id, record.bytes.length, position].forEach((value, part) => names.writeUInt16BE(value, at + part * 2));
    record.bytes.copy(names, newStorage + position); position += record.bytes.length;
  });
  tables.set('name', names); tables.get('head')!.writeUInt32BE(0, 8);
  const result = Buffer.alloc(12 + tables.size * 16 + [...tables.values()].reduce((sum, bytes) => sum + Math.ceil(bytes.length / 4) * 4, 0));
  result.writeUInt32BE(0x00010000, 0); result.writeUInt16BE(tables.size, 4);
  const selector = Math.floor(Math.log2(tables.size)), searchRange = 2 ** selector * 16;
  result.writeUInt16BE(searchRange, 6); result.writeUInt16BE(selector, 8); result.writeUInt16BE(tables.size * 16 - searchRange, 10);
  position = 12 + tables.size * 16;
  [...tables].forEach(([tag, bytes], i) => {
    const at = 12 + i * 16; result.write(tag, at, 'ascii'); result.writeUInt32BE(checksum(bytes), at + 4); result.writeUInt32BE(position, at + 8); result.writeUInt32BE(bytes.length, at + 12);
    bytes.copy(result, position); position += Math.ceil(bytes.length / 4) * 4;
  });
  result.writeUInt32BE((0xb1b0afba - checksum(result)) >>> 0, fontTable(result, 'head').offset + 8);
  return result;
}
async function readFixture(bytes: Buffer, request: Partial<Request> = {}): Promise<Face> {
  const fontsDirectory = await privateDirectory();
  await fs.writeFile(path.join(fontsDirectory, 'fixture.ttf'), bytes);
  return readWindowsPdfFont({ font: 'fixture.ttf', family: 'JCad Fixture', ...request }, { fontsDirectory });
}

describe('restricted-mode native PDF font admission (12.4)', () => {
  it('ordinary requests still refuse a preview/print face (control)', async () => {
    await expect(readFixture(pdfFixture({ fsType: 4, os2Version: 4 }))).rejects.toThrow('read-only PDF');
    await expect(readFixture(pdfFixture({ fsType: 4, os2Version: 4 }), { restricted: false })).rejects.toThrow('read-only PDF');
  });

  it('a restricted request admits a preview/print face and flags it as preview/print', async () => {
    const bytes = pdfFixture({ fsType: 4, os2Version: 4 });
    const face = await readFixture(bytes, { restricted: true });
    expect(face.previewPrint).toBe(true);
    expect(face.bytes).toEqual(bytes);
    expect(face.metrics.fsType).toBe(4);
    expect(face.os2Version).toBe(4);
  });

  it('a restricted request keeps v0-2 least-restrictive precedence (fsType 6 at v2 is preview/print)', async () => {
    const face = await readFixture(pdfFixture({ fsType: 6, os2Version: 2 }), { restricted: true });
    expect(face.previewPrint).toBe(true);
  });

  it('a restricted request admits an editable face without the preview/print flag', async () => {
    const face = await readFixture(pdfFixture({ fsType: 8, os2Version: 4 }), { restricted: true });
    expect(face.previewPrint).toBeFalsy();
    expect(face.metrics.fsType).toBe(8);
  });

  it.each([[2, 'restricted font'], [0x0204, 'bitmap-only'], [0x0200, 'bitmap-only'], [1, 'reserved'], [0x0010, 'reserved']])(
    'a restricted request still refuses fsType %i', async (fsType, problem) => {
      await expect(readFixture(pdfFixture({ fsType, os2Version: 4 }), { restricted: true })).rejects.toThrow(problem);
    });

  it('a restricted request still refuses conflicting permissions at OS/2 v3+', async () => {
    await expect(readFixture(pdfFixture({ fsType: 10, os2Version: 3 }), { restricted: true })).rejects.toThrow('conflicting');
  });
});
