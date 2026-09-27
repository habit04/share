import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { convertDwg } from '../src/io/dwg';
import { writeDxf, readDxf } from '../src/io/dxf';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload } from '../scripts/dwg-reader.mjs';

const fixtures = join(__dirname, '..', 'fixtures');
const files = ['example_r14.dwg', 'example_2000.dwg', 'example_2004.dwg', 'example_2007.dwg', 'example_2010.dwg', 'example_2013.dwg', 'example_2018.dwg'];

describe('DWG import (LibreDWG wasm)', () => {
  for (const f of files) {
    const path = join(fixtures, f);
    it.skipIf(!existsSync(path))(`converts ${f}`, async () => {
      const { payload } = await readDwgPayload(readFileSync(path), 'dwg');
      const { state } = convertDwg(payload);
      expect(state.entities.length).toBeGreaterThan(10);
      expect(state.layers.some((l) => l.name === '0')).toBe(true);
      const types = new Set(state.entities.map((e) => e.type));
      expect(types.has('line')).toBe(true);
      // inserts must resolve to block definitions we converted
      for (const e of state.entities) if (e.type === 'insert') expect(state.blocks[e.block], `block ${e.block}`).toBeDefined();
      // and the result must round-trip through our DXF writer/reader
      const back = readDxf(writeDxf(state));
      expect(back.entities.length).toBe(state.entities.length);
    }, 60000);
  }

  it.skipIf(!existsSync(join(fixtures, 'example_2000.dwg')))('keeps text, arcs and layers from example_2000.dwg', async () => {
    const { payload, version } = await readDwgPayload(readFileSync(join(fixtures, 'example_2000.dwg')), 'dwg');
    expect(version).toContain('2000');
    const { state } = convertDwg(payload);
    const text = state.entities.find((e) => e.type === 'text' && e.text === 'teksto simpla');
    expect(text).toBeDefined();
    const arc = state.entities.find((e) => e.type === 'arc');
    expect(arc).toBeDefined();
    if (arc?.type === 'arc') expect(arc.startAngle).toBeLessThan(2 * Math.PI + 1e-9); // radians, not degrees
    expect(state.layers.find((l) => l.name === 'Tavolo 2')?.locked).toBe(true);
    expect(state.layers.find((l) => l.name === 'Tavolo 2')?.color).toBe(2);
  }, 60000);
});
