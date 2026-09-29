import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { convertDwg, toImportPayload } from '../src/io/dwg';
import { writeDxf, readDxf } from '../src/io/dxf';
// @ts-expect-error plain JS helper shared with Electron main / CLI
import { readDwgPayload, payloadFromDatabase } from '../scripts/dwg-reader.mjs';

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

describe('DWG import of drafting entities', () => {
  it.skipIf(!existsSync(join(fixtures, 'example_2000.dwg')))('converts dimensions, ellipse, point, mtext, xline and ray with bulges kept', async () => {
    const { payload } = await readDwgPayload(readFileSync(join(fixtures, 'example_2000.dwg')), 'dwg');
    const { state, skipped } = convertDwg(payload);
    const types = new Set(state.entities.map((e) => e.type));
    for (const t of ['dimension', 'ellipse', 'point', 'mtext', 'xline', 'ray'] as const) expect(types.has(t), t).toBe(true);
    expect(skipped.DIMENSION ?? 0).toBeLessThanOrEqual(3); // ordinate dimensions are not modelled
    const dims = state.entities.filter((e) => e.type === 'dimension');
    expect(dims.length).toBeGreaterThanOrEqual(5);
    const aligned = dims.find((d) => d.type === 'dimension' && d.kind === 'aligned');
    expect(aligned).toBeDefined();
    if (aligned?.type === 'dimension') expect(aligned.style.name).toBe('ISO-25');
    const mt = state.entities.find((e) => e.type === 'mtext');
    if (mt?.type === 'mtext') {
      expect(mt.text).toContain('\n');
      expect(mt.width).toBeGreaterThan(0);
    }
    const bulged = state.entities.find((e) => e.type === 'polyline' && e.bulges?.some((b) => Math.abs(b) > 1e-9));
    expect(bulged).toBeDefined();
    expect(state.header?.units.insunits).toBe(4);
    expect(state.header?.limits.max.x).toBeCloseTo(420);
    // and everything survives our DXF writer / reader
    const back = readDxf(writeDxf(state));
    expect(back.entities.filter((e) => e.type === 'dimension').length).toBe(dims.length);
    expect(back.entities.some((e) => e.type === 'ellipse')).toBe(true);
  }, 60000);
});

describe('DWG payload of the desktop reader and the browser reader', () => {
  // scripts/dwg-reader.mjs (Electron main, CLI) and toImportPayload (browser) build the same payload.
  const db = {
    header: { INSUNITS: 4 },
    entities: [{ type: 'LINE' }],
    tables: {
      LAYER: { entries: [{ name: '0', colorIndex: 7, off: false, frozen: false, locked: false, lineweight: -3, lineType: 'Continuous', extra: 1 }] },
      BLOCK_RECORD: { entries: [{ name: 'LOGO', basePoint: { x: 0, y: 0, z: 0 }, entities: [], description: 'x', handle: '1F', flags: 4, extra: 1 }] },
    },
    objects: { IMAGEDEF: [{ handle: 42, fileName: 'C:/img/logo.png', extra: 1 }] },
  };
  const keysDeep = (v: unknown): string[] => {
    if (Array.isArray(v)) return v.flatMap((x, i) => keysDeep(x).map((k) => `${i}.${k}`));
    if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => [k, ...keysDeep(x).map((c) => `${k}.${c}`)]).sort();
    return [];
  };
  it('carries the same keys and values (image definitions, block handles and flags included)', () => {
    const node = payloadFromDatabase(db, 'R_2000');
    const browser = toImportPayload(db as unknown as Parameters<typeof toImportPayload>[0], 'R_2000');
    expect(keysDeep(node)).toEqual(keysDeep(browser));
    expect(node).toEqual(browser);
    expect(node.imageDefs).toEqual([{ handle: '42', fileName: 'C:/img/logo.png' }]);
    expect(node.blocks[0]).toMatchObject({ handle: '1F', flags: 4 });
  });
});

describe('DWG header dimension variables', () => {
  it('applies arrows, tolerances, alternate units, placement, colours and units from the header', () => {
    const header = {
      DIMSTYLE: 'Mech',
      DIMTXT: 0.2,
      DIMASZ: 0.15,
      DIMSAH: 1,
      DIMBLK: '',
      DIMBLK1: '_OPEN',
      DIMBLK2: '_DOT',
      DIMTOL: 1,
      DIMTP: 0.01,
      DIMTM: 0.02,
      DIMTDEC: 3,
      DIMTFAC: 0.7,
      DIMALT: 1,
      DIMALTF: 25.4,
      DIMALTD: 1,
      DIMALTU: 2,
      DIMAPOST: '[<> mm]',
      DIMTAD: 1,
      DIMJUST: 2,
      DIMTIH: 1,
      DIMTOH: 1,
      DIMSE1: 1,
      DIMSD2: 1,
      DIMDLE: 0.05,
      DIMDLI: 0.5,
      DIMCLRD: { index: 1, rgb: 0 },
      DIMCLRE: 3,
      DIMCLRT: { index: 2 },
      DIMATFIT: 1,
      DIMTIX: 1,
      DIMTOFL: 0,
      DIMPOST: '<>"',
      DIMRND: 0.25,
      DIMLFAC: 2,
      DIMZIN: 12,
    };
    const { state } = convertDwg({ header, entities: [], layers: [], blocks: [] });
    const ds = state.header!.dimStyle;
    expect(ds).toMatchObject({
      name: 'Mech',
      textHeight: 0.2,
      arrowSize: 0.15,
      arrow: 'open',
      arrow2: 'dot',
      tolerance: 'deviation',
      tolPlus: 0.01,
      tolMinus: 0.02,
      tolDecimals: 3,
      tolScale: 0.7,
      altUnits: true,
      altFactor: 25.4,
      altDecimals: 1,
      altLunit: 2,
      altPost: '[<> mm]',
      textVertical: 'above',
      textJustify: 'ext2',
      textAlign: 'horizontal',
      suppressExt1: true,
      suppressDimLine2: true,
      dimLineExtend: 0.05,
      baselineSpacing: 0.5,
      dimLineColor: 1,
      extLineColor: 3,
      textColor: 2,
      fit: 'arrows',
      textInside: true,
      dimLineInside: false,
      post: '<>"',
      round: 0.25,
      linearFactor: 2,
      suppressLeadingZeros: true,
      suppressTrailingZeros: true,
    });
    // DIMSAH off: DIMBLK sets both ends; BYBLOCK colours (0) stay the dimension's own colour.
    const plain = convertDwg({ header: { DIMSAH: 0, DIMBLK: '_ARCHTICK', DIMBLK1: '_OPEN', DIMCLRD: { index: 0 } }, entities: [], layers: [], blocks: [] }).state.header!.dimStyle;
    expect(plain.arrow).toBe('arch-tick');
    expect(plain.arrow2).toBeUndefined();
    expect(plain.dimLineColor).toBeUndefined();
  });
});
