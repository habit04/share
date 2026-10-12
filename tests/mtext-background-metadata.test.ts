import { describe, expect, it } from 'vitest';
import { Drawing } from '../src/core/document';
import type { MTextEntity, LeaderEntity } from '../src/core/entities';
import { readDxf, writeDxf } from '../src/io/dxf';
import { decodeDxfBytes } from '../src/io/encoding';
import { importReportOf } from '../src/io/import-report';
import { MTEXT_BACKGROUND_APP } from '../src/io/dxf/codes';
import { backgroundMetadataChunks, MAX_BACKGROUND_METADATA_BYTES } from '../src/io/dxf/mtext-background-data';

const bg = { flags: 0, scale: 3.75, color: 1 as const, trueColor: 0x123456, colorName: `Book$${'保存😀'.repeat(100)}`, transparency: 0xffffffff };
const e: MTextEntity = { type: 'mtext', id: 'off', layer: '0', color: 7, position: { x: 0, y: 0 }, text: 'DISABLED MASK', height: 2, width: 20, rotation: 0, attachment: 1, lineSpacing: 1, background: bg };
const state = (entity: MTextEntity | LeaderEntity = e) => new Drawing({ entities: [entity] }).snapshot;

function rows(dxf: string, kind: string) {
  const lines = dxf.trimEnd().split(/\r?\n/); const records: Array<Array<[number, string]>> = [];
  let record: Array<[number, string]> | null = null;
  for (let i = 0; i < lines.length; i += 2) {
    const code = Number(lines[i]); const value = lines[i + 1]!;
    if (code === 0) { if (record) records.push(record); record = value === kind ? [] : null; }
    else record?.push([code, value]);
  }
  if (record) records.push(record);
  return records;
}

/** Independent native input, with optional malformed JCad metadata supplied by the test. */
function native(metadata: Array<string | number>, flags = 0) {
  return [0, 'SECTION', 2, 'ENTITIES', 0, 'MTEXT', 100, 'AcDbEntity', 8, '0', 100, 'AcDbMText', 10, 0, 20, 0, 40, 2, 41, 20, 71, 1, 1, 'NATIVE', 90, flags, ...(flags ? [45, 1.5, 63, 2] : []), 1001, MTEXT_BACKGROUND_APP, ...metadata, 0, 'ENDSEC', 0, 'EOF'].join('\n');
}

describe('disabled MTEXT mask settings', () => {
  it('emits only native90=0, registers its metadata app and preserves every setting in bounded UTF-8 chunks', () => {
    const written = writeDxf(state()); const record = rows(written, 'MTEXT')[0]!;
    expect(record).toContainEqual([90, '0']);
    for (const code of [45, 63, 421, 431, 441]) expect(record.some(([c]) => c === code)).toBe(false);
    expect(rows(written, 'APPID').some((r) => r.some(([c, value]) => c === 2 && value === MTEXT_BACKGROUND_APP))).toBe(true);
    const chunks = record.filter(([c]) => c === 1000).map(([, value]) => value);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((s) => new TextEncoder().encode(s).length <= 250)).toBe(true);
    expect(new TextEncoder().encode(chunks.join('')).length).toBeLessThanOrEqual(MAX_BACKGROUND_METADATA_BYTES);
    const opened = readDxf(decodeDxfBytes(new TextEncoder().encode(written)).text);
    expect((opened.entities[0] as MTextEntity).background).toEqual(bg);
    expect(JSON.stringify(importReportOf(opened))).not.toMatch(/JCAD_MTEXT_BACKGROUND|inactive MTEXT/);
    // AutoCAD may remove the redundant native flag, while preserving registered XDATA.
    const normalized = written.replace(`90\r\n0\r\n1001\r\n${MTEXT_BACKGROUND_APP}`, `1001\r\n${MTEXT_BACKGROUND_APP}`);
    expect((readDxf(normalized).entities[0] as MTextEntity).background).toEqual(bg);
  });

  it('retains disabled annotation settings when a LEADER is exported and reopened', () => {
    const leader: LeaderEntity = { type: 'leader', id: 'l', layer: '0', color: 7, vertices: [{ x: -2, y: -2 }, { x: 0, y: 0 }], arrow: true, arrowSize: 0.2, text: 'LEADER MASK', textPosition: { x: 0, y: 0 }, textHeight: 2, textBackground: bg };
    const opened = readDxf(writeDxf(state(leader)));
    expect(opened.entities[0]).toMatchObject({ type: 'leader', textBackground: bg });
  });

  it('preserves literal CAD escape-looking book names without whole-file decoding corrupting the JSON', () => {
    const background = { ...bg, colorName: 'Book$Literal\\U+0041\\M+1ABCD' };
    const opened = readDxf(writeDxf(state({ ...e, background })));
    expect((opened.entities[0] as MTextEntity).background).toEqual(background);
    expect(JSON.stringify(importReportOf(opened))).not.toContain('not restored');
  });

  it('preserves whitespace in long names even at string-chunk boundaries', () => {
    const background = { ...bg, colorName: `Book$${'Blue '.repeat(70)}\u00a0\u2028 End ` };
    const chunks = backgroundMetadataChunks(background, 2);
    expect(chunks.every((chunk) => chunk === chunk.trimEnd())).toBe(true);
    const opened = readDxf(writeDxf(state({ ...e, background })));
    expect((opened.entities[0] as MTextEntity).background).toEqual(background);
  });

  it('bounds source chunks before joining/parsing and reports invalid settings rather than restoring them', () => {
    const tooLarge = [1000, 'x'.repeat(251)];
    const tooMany = Array.from({ length: 65 }, () => [1000, ' ']).flat();
    const tooManyBytes = Array.from({ length: 17 }, () => [1000, ' '.repeat(250)]).flat();
    const invalid = ['{', '{"version":1,"flags":0,"scale":999,"color":1}', '{"version":1,"flags":0,"scale":1.5,"color":1,"__proto__":{}}', '{"version":2,"flags":0,"scale":1.5,"color":1}', '{"version":1,"flags":0,"scale":1.5,"color":1,"trueColor":"123"}'];
    for (const metadata of [tooLarge, tooMany, tooManyBytes, ...invalid.map((s) => [1000, s])]) {
      const s = readDxf(native(metadata));
      expect((s.entities[0] as MTextEntity).background).toEqual({ flags: 0, scale: 1.5, color: 'ByLayer' });
      expect(JSON.stringify(importReportOf(s))).toContain('inactive MTEXT background settings are not restored');
    }
  });

  it('rejects duplicate app records and never allows inactive metadata to replace active native flags', () => {
    const data = JSON.stringify({ version: 1, flags: 0, scale: 4, color: 1 });
    const duplicate = readDxf(native([1000, data, 1001, MTEXT_BACKGROUND_APP, 1000, data]));
    expect(JSON.stringify(importReportOf(duplicate))).toContain('duplicate application records');
    const active = readDxf(native([1000, data], 1));
    expect((active.entities[0] as MTextEntity).background).toEqual({ flags: 1, scale: 1.5, color: 2 });
    expect(JSON.stringify(importReportOf(active))).toContain('native fill/frame flags are active');
  });

  it('reports the app as unmodeled when attached to an unrelated entity and safely rejects oversized writes', () => {
    const line = [0, 'SECTION', 2, 'ENTITIES', 0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 1, 1001, MTEXT_BACKGROUND_APP, 1000, '{}', 0, 'ENDSEC', 0, 'EOF'].join('\n');
    expect(JSON.stringify(importReportOf(readDxf(line)))).toContain('JCAD_MTEXT_BACKGROUND');
    expect(() => backgroundMetadataChunks({ ...bg, colorName: 'x'.repeat(4097) }, 2)).toThrow('4096 bytes');
  });
});
