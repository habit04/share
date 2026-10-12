import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { convertDwg } from '../src/io/dwg';
import { readDxf, writeDxf } from '../src/io/dxf';
// @ts-expect-error plain JS reader shared with Electron and the CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

describe('actual native DWG transparency', () => {
  it('keeps explicit native method 2, zero/full alpha and ByBlock through LibreDWG and DXF save', async () => {
    // Exported from JCad's hand-authored r2010-appearance.dxf with an extra plain line.
    // AutoCAD 2027 AUDIT found zero errors; DXFOUT confirmed each serialized group 440.
    const bytes = readFileSync(join(__dirname, 'fixtures/interchange/r2018-portable-appearance.dwg'));
    const expected = JSON.parse(readFileSync(join(__dirname, 'fixtures/interchange/r2018-portable-appearance.expected.json'), 'utf8')) as { dwgSha256: string; modelTransparencyByHandle: Record<string, number> };
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.dwgSha256);
    const { payload } = await readDwgPayload(bytes);
    for (const [handle, serialized] of Object.entries(expected.modelTransparencyByHandle)) {
      const entity = payload.entities.find((e: { handle: string }) => e.handle === handle);
      expect(entity, `native entity ${handle}`).toBeDefined();
      expect(entity.transparencyType).toBe(serialized >>> 24);
      expect(entity.transparency).toBe(serialized & 255);
    }
    const native = payload.entities.find((e: { handle: string }) => e.handle === '146');
    expect(native).toMatchObject({ type: 'INSERT', transparencyType: 2, transparency: 96 });
    const { state, report } = convertDwg(payload);
    // The native CMC reference, not its palette fallback, is the authoritative color.
    const named = payload.entities.find((e: { handle: string }) => e.handle === '14B');
    expect(named).toMatchObject({ color: 0xabcdef, colorName: 'Studio Book$Pearl Δ', transparency: 127 });
    expect(state.entities[5]).toMatchObject({ trueColor: 0xabcdef, colorName: 'Studio Book$Pearl Δ', transparency: 127 });
    expect(state.layers.find((layer) => layer.name === 'RICH')).toMatchObject({ trueColor: 0x123456, colorName: 'Studio Book$Teal 雷' });
    const alpha = state.entities.map((e) => e.transparency ?? 'ByLayer');
    expect(alpha).toEqual([96, 'ByLayer', 0, 255, 'ByBlock', 127, 'ByLayer']);
    expect(state.blocks.INNER?.entities.map((e) => e.transparency ?? 'ByLayer')).toEqual(['ByBlock', 'ByLayer', 'ByBlock', 200, 'ByLayer']);
    expect(state.blocks.OUTER?.entities.map((e) => e.transparency ?? 'ByLayer')).toEqual(['ByBlock', 'ByLayer', 160]);
    expect(JSON.stringify(report)).not.toContain('invalid or unexposed DWG transparency');
    expect(readDxf(writeDxf(state)).entities.map((e) => e.transparency ?? 'ByLayer')).toEqual(alpha);
  }, 60_000);
});
