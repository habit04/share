/**
 * Panel hardware: DIN rail, wire duct, enclosure and mounting-plate blocks,
 * the hardware BOM rows (panelHardwareRows), footprint alignment on a rail and
 * the terminal strip footprint.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { BlockDef, Entity, InsertEntity } from '../src/core/entities';
import { entityBounds, explodeInsert, newId } from '../src/core/entities';
import {
  RAIL_TYPES,
  DUCT_SIZES,
  ENCLOSURE_SIZES,
  railSpec,
  railBlock,
  makeRail,
  ductBlock,
  makeDuct,
  parseDuctSize,
  DUCT_COVER_INSET,
  enclosureBlock,
  makeEnclosure,
  parseEnclosureSize,
  plateOf,
  plateGridBlock,
  makePlateGrid,
  panelHardwareRows,
  panelHardwareReport,
  alignOnRail,
  railAxis,
  railAt,
  terminalStripFootprint,
  terminalStripLength,
  stripTerminals,
  MM_PER_IN,
} from '../src/electrical/panel-hardware';
import { panelHardwareRows as fromPanel, terminalStripTable, terminalStrips, terminalStripFootprintFor, footprintSize, makeFootprint, panelRows, footprintBlock } from '../src/electrical/panel';
import { isComponent, isFootprint } from '../src/electrical/families';
import { REPORTS, reportToCsv, reportToEntities } from '../src/electrical/reports';
import { LIBRARY_BLOCKS } from '../src/electrical/library';

const bounds = (b: BlockDef, filter: (e: Entity) => boolean = () => true) => {
  let min = { x: Infinity, y: Infinity };
  let max = { x: -Infinity, y: -Infinity };
  for (const e of b.entities.filter(filter)) {
    const bb = entityBounds(e, () => undefined);
    if (!bb) continue;
    min = { x: Math.min(min.x, bb.min.x), y: Math.min(min.y, bb.min.y) };
    max = { x: Math.max(max.x, bb.max.x), y: Math.max(max.y, bb.max.y) };
  }
  return { min, max };
};
const attr = (b: BlockDef, tag: string) => b.attributes.find((a) => a.tag === tag)?.default;

describe('DIN rail', () => {
  it('knows the standard rail widths in mm and inches', () => {
    expect(RAIL_TYPES.map((r) => [r.type, r.widthMm])).toEqual([
      ['TS35', 35],
      ['TS32', 32],
      ['TS15', 15],
    ]);
    expect(railSpec('ts35').width).toBeCloseTo(1.378, 3);
    expect(railSpec('TS32').width).toBeCloseTo(1.26, 3);
    expect(railSpec('TS15').width).toBeCloseTo(0.591, 3);
  });
  it('draws the rail as a block with centred slots and length / part attributes', () => {
    const b = railBlock('TS35', 12);
    expect(b.name).toBe('WD_PNL_DIN_TS35_L12000');
    const bb = bounds(b);
    expect(bb.min.x).toBeCloseTo(0, 9);
    expect(bb.max.x).toBeCloseTo(12, 9);
    expect(bb.max.y - bb.min.y).toBeCloseTo(35 / MM_PER_IN, 6);
    const arcs = b.entities.filter((e) => e.type === 'arc');
    expect(arcs.length / 2).toBe(8); // 36 mm pitch over 12 in
    // slots are symmetric about the rail centre
    const cx = (i: number) => { const a = arcs[i]!; return a.type === 'arc' ? a.center.x : NaN; };
    const centres = Array.from({ length: arcs.length / 2 }, (_, k) => (cx(2 * k) + cx(2 * k + 1)) / 2);
    expect(centres[0]!).toBeCloseTo(12 - centres[centres.length - 1]!, 9);
    expect(centres[1]! - centres[0]!).toBeCloseTo(36 / MM_PER_IN, 9);
    expect(attr(b, 'P_HW')).toBe('DINRAIL');
    expect(attr(b, 'P_LENGTH')).toBe('12.000');
    expect(attr(b, 'P_TYPE')).toBe('TS35');
    expect(b.attributes.every((a) => a.invisible)).toBe(true);
    const r = makeRail('TS15', { x: 2, y: 3 }, 6.5, Math.PI / 2, 'RAIL-15');
    expect(r.insert.attributes.P_CAT).toBe('RAIL-15');
    expect(r.insert.attributes.P_LENGTH).toBe('6.500');
    expect(r.insert.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(isComponent(r.insert)).toBe(false);
    // a short rail has no slot rather than one sticking out
    expect(railBlock('TS35', 0.5).entities.some((e) => e.type === 'arc')).toBe(false);
  });
});

describe('wire duct', () => {
  it('parses the stock sizes and draws the cover lines', () => {
    expect(DUCT_SIZES.map((d) => d.label)).toEqual(['1x1', '1.5x2', '2x2', '2x3', '3x3', '4x4']);
    expect(parseDuctSize('2X3')).toEqual({ width: 2, height: 3, label: '2x3' });
    expect(parseDuctSize(' 1.5 x 2 ')?.label).toBe('1.5x2');
    expect(parseDuctSize('4')?.label).toBe('4x4');
    expect(parseDuctSize('5x5')).toBeNull();
    const b = ductBlock(parseDuctSize('2x3')!, 10);
    expect(b.name).toBe('WD_PNL_DUCT_2X3_L10000');
    const lines = b.entities.filter((e) => e.type === 'line');
    expect(lines.map((l) => (l.type === 'line' ? Math.abs(l.a.y) : 0))).toEqual([1 - DUCT_COVER_INSET, 1 - DUCT_COVER_INSET]);
    expect(bounds(b).max.y - bounds(b).min.y).toBeCloseTo(2, 9);
    expect(ductBlock(parseDuctSize('1.5x2')!, 3).name).toBe('WD_PNL_DUCT_1P5X2_L3000');
    expect(makeDuct(parseDuctSize('1x1')!, { x: 0, y: 0 }, 4).insert.attributes.P_DESC1).toMatch(/Wire duct 1 x 1 in, 4\.000 in \(101\.6 mm\)/);
  });
});

describe('enclosure and mounting plate', () => {
  it('offers standard sizes, custom sizes and a plate 3 in smaller', () => {
    expect(ENCLOSURE_SIZES.map((e) => e.label)).toContain('24x20x8');
    expect(parseEnclosureSize('30 x 24 x 8')).toEqual({ height: 30, width: 24, depth: 8, label: '30x24x8' });
    expect(parseEnclosureSize('18x14')).toEqual({ height: 18, width: 14, depth: 0, label: '18x14' });
    expect(parseEnclosureSize('big')).toBeNull();
    expect(plateOf({ height: 24, width: 20 })).toEqual({ width: 17, height: 21, offset: { x: 1.5, y: 1.5 } });
  });
  it('draws the door swing on the hinge side, or none', () => {
    const size = parseEnclosureSize('24x20x8')!;
    const left = enclosureBlock(size, 'LEFT');
    const swing = left.entities.find((e) => e.type === 'arc');
    expect(swing?.type === 'arc' && [swing.center.x, swing.center.y, swing.radius]).toEqual([0, 0, 20]);
    expect(bounds(left).min.y).toBeCloseTo(-20, 9);
    const right = enclosureBlock(size, 'RIGHT');
    const rs = right.entities.find((e) => e.type === 'arc');
    expect(rs?.type === 'arc' && rs.center.x).toBe(20);
    const none = enclosureBlock(size, 'NONE');
    expect(none.entities.some((e) => e.type === 'arc')).toBe(false);
    expect(bounds(none).min.y).toBeCloseTo(0, 9);
    expect(bounds(none).max.x).toBeCloseTo(20, 9);
    expect(left.name).not.toBe(right.name);
    // two hinges on a short door, three on a tall one
    const hinges = (b: BlockDef) => b.entities.filter((e) => e.type === 'polyline' && Math.abs(bounds({ ...b, entities: [e] }).max.x - bounds({ ...b, entities: [e] }).min.x - 0.25) < 1e-9).length;
    expect(hinges(left)).toBe(2);
    expect(hinges(enclosureBlock(parseEnclosureSize('48x36x12')!, 'LEFT'))).toBe(3);
    const ins = makeEnclosure(size, 'LEFT', { x: 0, y: 0 }, 'ENC1').insert;
    expect(ins.attributes.P_TAG1).toBe('ENC1');
    expect(ins.attributes.P_PLATE).toBe('17x21');
  });
  it('draws a plate grid at the requested spacing', () => {
    const b = plateGridBlock(10, 8, 1);
    expect(b.entities.filter((e) => e.type === 'line')).toHaveLength(9 + 7);
    expect(plateGridBlock(10, 8, 2).entities.filter((e) => e.type === 'line')).toHaveLength(4 + 3);
    expect(attr(b, 'P_HW')).toBe('PLATE');
    expect(makePlateGrid({ x: 1, y: 1 }, 10, 8, 1).insert.position).toEqual({ x: 1, y: 1 });
  });
});

describe('panel hardware rows (BOM hook)', () => {
  it('totals rail and duct lengths per type and part number and lists enclosures / plates per piece', () => {
    const d = new Drawing();
    const parts = [
      makeRail('TS35', { x: 0, y: 0 }, 12, 0, 'NS35'),
      makeRail('TS35', { x: 0, y: 3 }, 6, 0, 'NS35'),
      makeRail('TS35', { x: 0, y: 6 }, 4, 0, 'OTHER'),
      makeRail('TS15', { x: 0, y: 9 }, 2),
      makeDuct(parseDuctSize('2x3')!, { x: 0, y: 12 }, 20),
      makeDuct(parseDuctSize('2x3')!, { x: 0, y: 15 }, 10),
      makeEnclosure(parseEnclosureSize('24x20x8')!, 'LEFT', { x: 30, y: 0 }),
      makePlateGrid({ x: 31.5, y: 1.5 }, 17, 21, 1),
    ];
    for (const p of parts) {
      d.ensureBlocks([p.block]);
      d.addEntities([p.insert]);
    }
    const rows = panelHardwareRows(d);
    expect(rows.map((r) => [r.kind, r.type, r.cat, r.qty, r.length])).toEqual([
      ['ENCLOSURE', '24x20x8', '', 1, 0],
      ['PLATE', '17x21', '', 1, 0],
      ['DINRAIL', 'TS15', '', 1, 2],
      ['DINRAIL', 'TS35', 'NS35', 2, 18],
      ['DINRAIL', 'TS35', 'OTHER', 1, 4],
      ['DUCT', '2x3', '', 2, 30],
    ]);
    expect(rows.find((r) => r.cat === 'NS35')!.lengthMm).toBeCloseTo(457.2, 6);
    expect(fromPanel(d)).toEqual(rows);
    const rep = panelHardwareReport(d);
    expect(rep.columns).toEqual(['Item', 'Type / Size', 'Description', 'Manufacturer', 'Catalog', 'Qty', 'Length (in)', 'Length (mm)']);
    expect(rep.rows[3]).toEqual(['DIN rail', 'TS35', 'DIN rail TS35 x 7.5 top hat, slotted', '', 'NS35', '2', '18.000', '457.2']);
    expect(rep.rows[0]![2]).toBe('Enclosure 24 x 20 x 8 in (H x W x D)');
    // hardware is not a footprint or a component: the panel component report is unchanged
    expect(panelRows(d.entities)).toEqual([]);
    expect(panelHardwareRows({ entities: [] })).toEqual([]);
    // Registered with the other reports (Reports dialog tab, CSV, put on drawing, project-wide).
    const entry = REPORTS.find((r) => r.key === 'panelhw')!;
    expect(entry).toMatchObject({ name: 'Panel Hardware', group: 'panel' });
    const built = entry.build(d);
    expect(built).toEqual(rep);
    expect(reportToCsv(built).split(/\r?\n/)[0]).toBe('Item,Type / Size,Description,Manufacturer,Catalog,Qty,Length (in),Length (mm)');
    expect(entry.build(d, ['Type / Size', 'Qty']).rows[3]).toEqual(['TS35', '2']);
    expect(reportToEntities(built, { x: 0, y: 0 }).some((e) => e.type === 'text' && e.text === 'NS35')).toBe(true);
  });
  it('treats cable markers and panel hardware as furniture, not components', () => {
    const at = (block: string): InsertEntity => ({ id: newId(), layer: '0', color: 'ByLayer', type: 'insert', block, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: { TAG1: 'X' } });
    expect(isComponent(at('WD_CABLE'))).toBe(false);
    expect(isComponent(at('WD_PNL_DIN_TS35_L10'))).toBe(false);
    expect(isComponent(at('HPB11_NO'))).toBe(true);
  });
});

describe('footprint alignment on a rail', () => {
  const rail = makeRail('TS35', { x: 1, y: 5 }, 10).insert;
  it('places footprints in order from the rail start with a gap', () => {
    const items = [
      { id: 'b', position: { x: 6, y: 9 }, size: 1.2 },
      { id: 'a', position: { x: 2, y: 2 }, size: 0.9 },
    ];
    const r = alignOnRail(items, railAxis(rail), 0.1);
    expect(r.positions.get('a')).toEqual({ x: 1 + 0.25 + 0.45, y: 5 });
    expect(r.positions.get('b')!.x).toBeCloseTo(1 + 0.25 + 0.9 + 0.1 + 0.6, 9);
    expect(r.overflow).toBe(0);
  });
  it('spreads them evenly, centres a single one and reports an overflow', () => {
    const items = [0, 1, 2].map((i) => ({ id: `f${i}`, position: { x: i, y: 0 }, size: 1 }));
    const even = alignOnRail(items, railAxis(rail), 'even');
    expect(even.gap).toBeCloseTo((10 - 0.5 - 3) / 2, 3);
    expect(even.positions.get('f2')!.x).toBeCloseTo(1 + 10 - 0.25 - 0.5, 9);
    const one = alignOnRail([items[0]!], railAxis(rail), 'even');
    expect(one.positions.get('f0')).toEqual({ x: 6, y: 5 });
    const over = alignOnRail(items, railAxis(rail), 4);
    expect(over.overflow).toBeCloseTo(3 + 8 - 9.5, 9);
  });
  it('finds the rail under a pick anywhere on its band', () => {
    const other = makeRail('TS15', { x: 1, y: 5.5 }, 10).insert;
    expect(railAt([rail, other], { x: 5, y: 5 })).toBe(rail);
    expect(railAt([rail, other], { x: 5, y: 5.52 })).toBe(other);
    expect(railAt([rail, other], { x: 5, y: 4.2 })).toBeNull();
    expect(railAt([rail, other], { x: 11.2, y: 5 })).toBeNull();
    expect(railAt([rail, other], { x: 11.2, y: 5 }, 0.3)).toBe(rail);
    const v = makeRail('TS35', { x: 0, y: 0 }, 8, Math.PI / 2).insert;
    expect(railAt([v], { x: 0.5, y: 4 })).toBe(v);
    expect(railAt([v], { x: 4, y: 0.5 })).toBeNull();
  });
  it('follows a vertical rail', () => {
    const v = makeRail('TS35', { x: 0, y: 0 }, 8, Math.PI / 2).insert;
    const r = alignOnRail([{ id: 'x', position: { x: 3, y: 3 }, size: 1 }], railAxis(v), 0);
    const p = r.positions.get('x')!;
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(0.75, 9);
  });
  it('measures footprint bodies (family footprints and terminal strips)', () => {
    const fp = makeFootprint({ tag: 'CR1', family: 'CR', desc: '', mfg: '', cat: '', inst: '', loc: '' }, { x: 0, y: 0 }, '1');
    expect(footprintSize(fp)).toEqual({ width: 1.2, height: 1.6 });
    const ts: InsertEntity = { ...fp, block: 'WD_FP_TSTRIP_TB1', attributes: { P_TERMS: '1,2,3' } };
    expect(footprintSize(ts).width).toBeCloseTo(terminalStripLength(3), 9);
  });
});

describe('terminal strip footprint', () => {
  function schematic(): Drawing {
    const d = new Drawing();
    d.ensureBlocks(LIBRARY_BLOCKS);
    const term = (n: string, strip: string, y: number): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HT0001', position: { x: 3, y }, rotation: 0, scale: 1, attributes: { TERM01: n, TAGSTRIP: strip } });
    d.addEntities([term('3', 'TB1', 10), term('1', 'TB1', 9), term('2', 'TB1', 8), term('1', 'TB1', 7), term('10', 'TB2', 6), term('PE', 'TB1', 5)]);
    return d;
  }
  it('numbers the terminals from the terminal strip table, each once', () => {
    const d = schematic();
    const rows = terminalStripTable(d.entities, d.lookupBlock);
    expect(terminalStrips(rows)).toEqual(['TB1', 'TB2']);
    expect(stripTerminals(rows, 'TB1')).toEqual(['1', '2', '3', 'PE']);
    const b = terminalStripFootprintFor(rows, 'TB1');
    expect(b.name).toBe('WD_FP_TSTRIP_TB1');
    const texts = b.entities.filter((e) => e.type === 'text').map((e) => (e.type === 'text' ? e.text : ''));
    expect(texts).toEqual(['1', '2', '3', 'PE']);
    expect(attr(b, 'P_TAG1')).toBe('TB1');
    expect(attr(b, 'P_DESC2')).toBe('4 TERMINALS');
    expect(attr(b, 'P_TERMS')).toBe('1,2,3,PE');
    expect(attr(b, 'P_FAMILY')).toBe('TB');
    // numbers sit inside their terminal
    const terminals = b.entities.filter((e) => e.type === 'polyline').slice(2, 6);
    b.entities
      .filter((e) => e.type === 'text')
      .forEach((t, i) => {
        const tb = bounds({ ...b, entities: [terminals[i]!] });
        const x = t.type === 'text' ? t.position.x : 0;
        expect(x).toBeGreaterThan(tb.min.x);
        expect(x).toBeLessThan(tb.max.x);
      });
    // body length = end stops + terminals + end plate, centred on the base point
    const body = bounds(b, (e) => e.type === 'polyline');
    expect(body.max.x - body.min.x).toBeCloseTo(terminalStripLength(4), 9);
    expect(body.max.x + body.min.x).toBeCloseTo(0, 9);
  });
  it('draws jumper bars when jumper data is given, stacking overlapping ones', () => {
    const none = terminalStripFootprint('TB1', ['1', '2', '3', '4']);
    const withJ = terminalStripFootprint('TB1', ['1', '2', '3', '4'], { jumpers: [['1', '3'], ['2', '4'], ['9', '1']] });
    const dots = (b: BlockDef) => b.entities.filter((e) => e.type === 'circle' && e.filled).length;
    expect(dots(none)).toBe(0);
    expect(dots(withJ)).toBe(3 + 3);
    const bars = withJ.entities.filter((e) => e.type === 'line').length - none.entities.filter((e) => e.type === 'line').length;
    expect(bars).toBe(2);
    const barYs = withJ.entities.filter((e) => e.type === 'circle' && e.filled).map((e) => (e.type === 'circle' ? e.center.y : 0));
    expect(new Set(barYs.map((y) => y.toFixed(3))).size).toBe(2);
  });
  it('is a panel footprint that shows in the panel list', () => {
    const d = new Drawing();
    const b = terminalStripFootprint('TB1', ['1', '2']);
    d.ensureBlocks([b, footprintBlock('CR')]);
    const ins: InsertEntity = { id: 'ts', layer: 'PANEL', color: 'ByLayer', type: 'insert', block: b.name, position: { x: 0, y: 0 }, rotation: 0, scale: 1, attributes: Object.fromEntries(b.attributes.map((a) => [a.tag, a.default])) };
    expect(isFootprint(ins)).toBe(true);
    expect(isComponent(ins)).toBe(false);
    d.addEntities([{ ...ins, attributes: { ...ins.attributes, P_ITEM: '4' } }]);
    expect(panelRows(d.entities)).toEqual([{ item: '4', tag: 'TB1', desc: 'TERMINAL STRIP TB1 2 TERMINALS', mfg: '', cat: '', loc: '', block: 'WD_FP_TSTRIP_TB1' }]);
    expect(explodeInsert(d.entities[0] as InsertEntity, d.lookupBlock).some((e) => e.type === 'text' && e.text === 'TB1')).toBe(true);
  });
});
