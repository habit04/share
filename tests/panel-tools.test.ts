/**
 * Panel layout commands: AEDINRAIL, AEWIREDUCT, AEPANEL, AEPANELGRID,
 * AEFOOTPRINTALIGN, AETERMFOOTPRINT and their registration.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { InsertEntity } from '../src/core/entities';
import { dinRailTool, wireDuctTool, enclosureTool, plateGridTool, footprintAlignTool, terminalStripTool, parseRailType, logPanelHardware, registerPanelCommands } from '../src/tools/panel';
import { makeFootprint, footprintBlock, type TerminalRow } from '../src/electrical/panel';
import { panelHardwareRows, terminalStripLength } from '../src/electrical/panel-hardware';
import { fakeContext, drive } from './fake-context';
import type { Editor } from '../src/app/editor';

const inserts = (d: Drawing) => d.entities.filter((e): e is InsertEntity => e.type === 'insert');

describe('AEDINRAIL', () => {
  it('draws a rail between two points and remembers the type', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(dinRailTool(), ctx, ['T', 'TS32', { x: 1, y: 2 }, { x: 13, y: 2 }]);
    expect(ctx.finished).toBe(true);
    const [rail] = inserts(d);
    expect(rail!.block).toBe('WD_PNL_DIN_TS32_L12000');
    expect(rail!.attributes.P_TYPE).toBe('TS32');
    expect(rail!.position).toEqual({ x: 1, y: 2 });
    expect(rail!.rotation).toBe(0);
    expect(d.blocks[rail!.block]).toBeDefined();
    expect(d.layer('PANEL')).toBeDefined();
    expect(ctx.logs.at(-1)).toMatch(/DIN rail TS32 \(32 mm wide\), 12\.000 in \(304\.8 mm\)/);
    // one undo removes both the rail and its block
    d.undo();
    expect(inserts(d)).toHaveLength(0);
    // the next rail defaults to TS32
    drive(dinRailTool(), ctx, [{ x: 0, y: 0 }, { x: 0, y: 5 }]);
    expect(inserts(d)[0]!.attributes.P_TYPE).toBe('TS32');
    expect(inserts(d)[0]!.rotation).toBeCloseTo(Math.PI / 2, 9);
    drive(dinRailTool(), ctx, ['T', '35', { x: 0, y: 0 }, { x: 1, y: 0 }]);
    expect(inserts(d)[1]!.attributes.P_TYPE).toBe('TS35');
  });
  it('takes a start point, a length and a direction, and a part number', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(dinRailTool(), ctx, ['P', 'ns 35 perf', { x: 2, y: 2 }, 'L', '7.5', 'V']);
    const [rail] = inserts(d);
    expect(rail!.attributes.P_LENGTH).toBe('7.500');
    expect(rail!.attributes.P_CAT).toBe('NS 35 PERF');
    expect(rail!.rotation).toBeCloseTo(Math.PI / 2, 9);
    drive(dinRailTool(), ctx, [{ x: 0, y: 0 }, 'L', '', '']);
    expect(inserts(d)[1]!.attributes.P_LENGTH).toBe('7.500');
    expect(inserts(d)[1]!.rotation).toBe(0);
    // too short a pick is refused and the prompt repeats
    drive(dinRailTool(), ctx, [{ x: 0, y: 0 }, { x: 0.1, y: 0 }]);
    expect(ctx.logs.at(-1)).toMatch(/at least 0\.5 in/);
    expect(parseRailType('ts15')).toBe('TS15');
    expect(parseRailType('40')).toBeNull();
  });
});

describe('AEWIREDUCT', () => {
  it('draws a duct run of the chosen size', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(wireDuctTool(), ctx, ['S', '1.5x2', { x: 0, y: 0 }, { x: 20, y: 0 }]);
    const [duct] = inserts(d);
    expect(duct!.block).toBe('WD_PNL_DUCT_1P5X2_L20000');
    expect(duct!.attributes.P_TYPE).toBe('1.5x2');
    drive(wireDuctTool(), ctx, ['S', '7x7', { x: 0, y: 0 }, { x: 5, y: 0 }]);
    expect(ctx.logs.some((l) => l.startsWith('Stock duct sizes'))).toBe(true);
    expect(inserts(d)[1]!.attributes.P_TYPE).toBe('1.5x2');
  });
});

describe('AEPANEL', () => {
  it('places a standard enclosure with the chosen hinge', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(enclosureTool(), ctx, ['30x24x8', 'R', { x: 0, y: 0 }]);
    const [enc] = inserts(d);
    expect(enc!.attributes.P_TYPE).toBe('30x24x8');
    expect(enc!.attributes.P_HINGE).toBe('RIGHT');
    expect(ctx.logs.at(-1)).toMatch(/mounting plate 21 x 27 in/);
  });
  it('accepts a custom size and re-prompts for nonsense', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(enclosureTool(), ctx, ['huge', 'C', '18x14x6', 'N', { x: 5, y: 5 }]);
    const [enc] = inserts(d);
    expect(enc!.attributes.P_TYPE).toBe('18x14x6');
    expect(enc!.block).toBe('WD_PNL_ENC_18X14X6_N');
    expect(ctx.logs.some((l) => l.includes('Enter a size such as'))).toBe(true);
  });
});

describe('AEPANELGRID', () => {
  it('draws a plate from two corners, or the plate of an enclosure', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(plateGridTool(), ctx, ['S', '0.5', { x: 4, y: 3 }, { x: 0, y: 0 }]);
    const [plate] = inserts(d);
    expect(plate!.position).toEqual({ x: 0, y: 0 });
    expect(plate!.attributes.P_TYPE).toBe('4x3');
    expect(plate!.attributes.P_GRID).toBe('0.500');
    drive(enclosureTool(), ctx, ['24x20x8', 'L', { x: 10, y: 0 }]);
    drive(plateGridTool(), ctx, ['E', { x: 10, y: 12 }]);
    const grid = inserts(d).at(-1)!;
    expect(grid.attributes.P_HW).toBe('PLATE');
    expect(grid.position).toEqual({ x: 11.5, y: 1.5 });
    expect(grid.attributes.P_TYPE).toBe('17x21');
    expect(panelHardwareRows(d).map((r) => r.kind)).toEqual(['ENCLOSURE', 'PLATE', 'PLATE']);
  });
});

describe('AEFOOTPRINTALIGN', () => {
  it('snaps the selected footprints onto the rail in order with the gap, or spread evenly', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(dinRailTool(), ctx, ['T', 'TS35', { x: 0, y: 10 }, { x: 10, y: 10 }]);
    d.ensureBlocks([footprintBlock('CR'), footprintBlock('M')]);
    const a = makeFootprint({ tag: 'CR1', family: 'CR', desc: '', mfg: '', cat: '', inst: '', loc: '' }, { x: 7, y: 3 }, '1');
    const b = makeFootprint({ tag: 'M1', family: 'M', desc: '', mfg: '', cat: '', inst: '', loc: '' }, { x: 2, y: 4 }, '2');
    d.addEntities([a, b]);
    drive(footprintAlignTool(), ctx, [{ select: [a.id, b.id] }, { x: 5, y: 10.1 }, '0.2']);
    const m = d.entity(b.id) as InsertEntity;
    const cr = d.entity(a.id) as InsertEntity;
    expect(m.position.y).toBeCloseTo(10, 9);
    expect(m.position.x).toBeCloseTo(0.25 + 0.9, 9);
    expect(cr.position.x).toBeCloseTo(0.25 + 1.8 + 0.2 + 0.6, 9);
    ctx.selection = new Set([a.id, b.id]);
    drive(footprintAlignTool(), ctx, [{ x: 5, y: 10 }, 'E']);
    expect((d.entity(a.id) as InsertEntity).position.x).toBeCloseTo(10 - 0.25 - 0.6, 9);
    expect(ctx.logs.at(-1)).toMatch(/2 footprint\(s\) aligned/);
  });
  it('turns footprints with a vertical rail and warns when they overflow', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    drive(dinRailTool(), ctx, [{ x: 0, y: 0 }, { x: 0, y: 2 }]);
    d.ensureBlocks([footprintBlock('M')]);
    const fps = [0, 1].map((i) => makeFootprint({ tag: `M${i}`, family: 'M', desc: '', mfg: '', cat: '', inst: '', loc: '' }, { x: 3, y: i }, String(i)));
    d.addEntities(fps);
    drive(footprintAlignTool(), ctx, [{ select: fps.map((f) => f.id) }, { x: 3, y: 3 }, { x: 0, y: 1 }, '0']);
    expect(ctx.logs.some((l) => l.includes('Select a DIN rail'))).toBe(true);
    const moved = d.entity(fps[0]!.id) as InsertEntity;
    expect(moved.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(moved.position.x).toBeCloseTo(0, 9);
    expect(ctx.logs.at(-1)).toMatch(/past the usable rail length/);
  });
});

describe('AETERMFOOTPRINT', () => {
  const row = (strip: string, number: string, id = number): TerminalRow => ({ id, strip, number, leftWire: '', leftDevice: '', rightWire: '', rightDevice: '', ref: '' });
  it('places a strip footprint and replaces it (same item number) when placed again', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    const rows = [row('TB1', '1'), row('TB1', '2'), row('TB2', '5')];
    drive(terminalStripTool(rows), ctx, ['TB9', 'tb1', { x: 5, y: 5 }]);
    expect(ctx.logs.some((l) => l.startsWith('No strip TB9'))).toBe(true);
    const [fp] = inserts(d);
    expect(fp!.block).toBe('WD_FP_TSTRIP_TB1');
    expect(fp!.attributes.P_ITEM).toBe('1');
    expect(fp!.attributes.P_TERMS).toBe('1,2');
    // more terminals later: the definition is rebuilt and the old footprint replaced
    drive(terminalStripTool([...rows, row('TB1', '3')], () => [['1', '2']]), ctx, ['', { x: 6, y: 5 }]);
    const all = inserts(d);
    expect(all).toHaveLength(1);
    expect(all[0]!.attributes.P_ITEM).toBe('1');
    expect(all[0]!.attributes.P_TERMS).toBe('1,2,3');
    expect(d.blocks.WD_FP_TSTRIP_TB1!.entities.some((e) => e.type === 'circle' && e.filled)).toBe(true);
    expect(ctx.logs.at(-1)).toMatch(/old footprint replaced/);
    drive(terminalStripTool([]), ctx, []);
    expect(ctx.logs.at(-1)).toMatch(/No terminals found/);
    expect(terminalStripLength(3)).toBeGreaterThan(terminalStripLength(2));
  });
});

describe('registration and listing', () => {
  it('registers the panel commands through registerPanelCommands', () => {
    const names: string[] = [];
    const fake = { register: (def: { name: string; aliases: string[] }) => names.push(def.name, ...def.aliases) } as unknown as Editor;
    registerPanelCommands(fake);
    for (const n of ['AEDINRAIL', 'AEWIREDUCT', 'AEPANEL', 'AEPANELGRID', 'AEFOOTPRINTALIGN', 'AETERMFOOTPRINT', 'AEPANELHW', 'DINRAIL', 'WIREDUCT']) expect(names).toContain(n);
  });
  it('lists the hardware on the command line', () => {
    const d = new Drawing();
    const ctx = fakeContext(d);
    const lines: string[] = [];
    expect(logPanelHardware((t) => lines.push(t), d.entities)).toBe(0);
    drive(dinRailTool(), ctx, ['T', 'TS35', { x: 0, y: 0 }, { x: 10, y: 0 }]);
    drive(dinRailTool(), ctx, [{ x: 0, y: 3 }, { x: 5, y: 3 }]);
    lines.length = 0;
    expect(logPanelHardware((t) => lines.push(t), d.entities)).toBe(1);
    expect(lines[1]).toMatch(/DIN rail\s+TS35\s+qty\s+2\s+total 15\.000 in \(381\.0 mm\)/);
  });
});
