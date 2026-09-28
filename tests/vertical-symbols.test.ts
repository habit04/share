/**
 * Vertical symbols end to end: top / bottom connection detection, attribute
 * rotation through DXF, vertical wire breaking, the icon menu's Vertical
 * orientation (library twin or a generated V block) and definition precedence.
 */
import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import type { AttributeDef, BlockDef, Entity, InsertEntity, LineEntity } from '../src/core/entities';
import { newId, explodeInsert } from '../src/core/entities';
import { ALL_SYMBOLS, findSymbol, tagPrefix } from '../src/electrical/symbols';
import { connectionPoints, withAcadeAttributes, verticalVariant, verticalVariantName, isVerticalBlock, pinDir } from '../src/electrical/attributes';
import { breakForInsert, liftFromWires, connectionLevels, connectionColumns, connectsVertically, worldConnections, staleDots, wireDegree, relocateComponent, applyWireEdit } from '../src/electrical/wires';
import { wireDot } from '../src/electrical/ladder';
import { writeDxf, readDxf } from '../src/io/dxf';
import { ComponentTool, resolveSymbolPick, symbolPick } from '../src/tools/electrical';
import { fakeContext } from './fake-context';

const line = (x1: number, y1: number, x2: number, y2: number, layer = '0'): LineEntity => ({ id: newId(), layer, color: 'ByLayer', type: 'line', a: { x: x1, y: y1 }, b: { x: x2, y: y2 } });
const wire = (x1: number, y1: number, x2: number, y2: number): LineEntity => line(x1, y1, x2, y2, 'WIRES');
const ins = (block: string, x: number, y: number, attrs: Record<string, string> = {}, rotation = 0): InsertEntity => ({ id: newId(), layer: 'SYMS', color: 'ByLayer', type: 'insert', block, position: { x, y }, rotation, scale: 1, attributes: attrs });

/** A hand-made vertical limit switch: stubs on the axis from y = +-0.375, TAG1 to the right. */
function verticalSwitch(name = 'USER_VLS_NO'): BlockDef {
  const tag: AttributeDef = { tag: 'TAG1', prompt: 'Component tag', default: '', position: { x: 0.2, y: 0.05 }, height: 0.125, align: 'left' };
  const desc: AttributeDef = { tag: 'DESC1', prompt: 'Description', default: '', position: { x: 0.2, y: -0.12 }, height: 0.1, align: 'left' };
  const geometry: Entity[] = [line(0, 0.375, 0, 0.125), line(0, -0.125, 0, -0.375), line(0, 0.125, -0.1, -0.1), line(-0.1, -0.125, 0.1, -0.125)];
  return withAcadeAttributes({ name, description: 'Vertical limit switch NO', basePoint: { x: 0, y: 0 }, entities: geometry, attributes: [tag, desc] }, 'LS');
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('connection points of vertical symbols', () => {
  it('detects stubs ending on the axis at y = +-0.375 as top / bottom connections', () => {
    const v = verticalSwitch();
    const pts = connectionPoints(v);
    expect(pts.map((p) => [p.tag, p.point.x, p.point.y])).toEqual([
      ['X2TERM01', 0, 0.375],
      ['X8TERM02', 0, -0.375],
    ]);
    expect(isVerticalBlock(v)).toBe(true);
    // withAcadeAttributes numbered them with the family defaults (LS is a plain 1/2 device, NO suffix -> 13/14)
    expect(v.attributes.find((a) => a.tag === 'X2TERM01')?.default).toBe('13');
    expect(v.attributes.find((a) => a.tag === 'X8TERM02')?.default).toBe('14');
  });
  it('keeps the built-in horizontal, one-sided and ground symbols unchanged', () => {
    expect(connectionPoints(findSymbol('HPB11_NO')!).map((p) => p.tag)).toEqual(['X1TERM01', 'X4TERM02']);
    expect(connectionPoints(findSymbol('HGND')!).map((p) => [p.tag, p.point.y])).toEqual([['X2TERM01', 0]]);
    expect(connectionPoints(findSymbol('HPLCI')!).map((p) => p.tag)).toEqual(['X1TERM01']);
    expect(isVerticalBlock(findSymbol('HPB11_NO')!)).toBe(false);
    for (const s of ALL_SYMBOLS) for (const c of connectionPoints(s)) expect(pinDir(c.tag)).toBe(c.dir);
  });
});

describe('attribute rotation', () => {
  it('round-trips AttributeDef.rotation through DXF (ATTDEF group 50) and rotates the insert text', () => {
    const rotated: BlockDef = {
      ...verticalSwitch('ROT1'),
      attributes: verticalSwitch('ROT1').attributes.map((a) => (a.tag === 'TAG1' ? { ...a, rotation: Math.PI / 2 } : a)),
    };
    const d = new Drawing();
    d.ensureBlocks([rotated]);
    d.addEntities([ins('ROT1', 2, 2, { TAG1: 'LS1' }, Math.PI / 4)]);
    const back = readDxf(writeDxf(d.snapshot));
    const tag = back.blocks.ROT1!.attributes.find((a) => a.tag === 'TAG1')!;
    expect(tag.rotation).toBeCloseTo(Math.PI / 2, 9);
    expect(back.blocks.ROT1!.attributes.find((a) => a.tag === 'DESC1')!.rotation).toBeUndefined();
    // the rendered attribute text turns with the insert plus its own rotation
    const text = explodeInsert(d.entities[0] as InsertEntity, d.lookupBlock).find((e) => e.type === 'text' && e.text === 'LS1');
    expect(text?.type === 'text' && text.rotation).toBeCloseTo(Math.PI / 4 + Math.PI / 2, 9);
    // the DXF ATTRIB carries the combined angle
    const dxf = writeDxf(d.snapshot);
    const attrib = dxf.slice(dxf.indexOf('ATTRIB'));
    expect(attrib).toMatch(/\r\n50\r\n135(\.0*)?\r\n/);
  });
});

describe('vertical wire breaking', () => {
  function tee(): { d: Drawing; vert: LineEntity } {
    const d = new Drawing();
    d.ensureBlocks([...ALL_SYMBOLS, verticalSwitch()]);
    const vert = wire(4, 8, 4, 6);
    d.addEntities([wire(1, 8, 9, 8), vert, wireDot({ x: 4, y: 8 })]);
    return { d, vert };
  }
  it('breaks a vertical wire around a top / bottom symbol and keeps the junction dot at the tee', () => {
    const { d } = tee();
    const sym = ins('USER_VLS_NO', 4, 7, { TAG1: 'LS1' });
    expect(connectsVertically(sym, d.lookupBlock)).toBe(true);
    expect(connectionLevels(sym, d.lookupBlock)).toEqual([]);
    expect(connectionColumns(sym, d.lookupBlock)).toEqual([4]);
    const after = breakForInsert([...d.entities, sym], sym, d.lookupBlock);
    const verticals = after.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.x - e.b.x) < 1e-9);
    expect(verticals.map((w) => [Math.max(w.a.y, w.b.y), Math.min(w.a.y, w.b.y)]).sort((p, q) => q[0]! - p[0]!)).toEqual([
      [8, 7.375],
      [6.625, 6],
    ]);
    // the rung stays whole, the tee still has three wire ends: the dot is not stale
    expect(after.filter((e) => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.y - 8) < 1e-9 && Math.abs(e.b.y - 8) < 1e-9)).toHaveLength(1);
    expect(wireDegree(after, { x: 4, y: 8 })).toBe(3);
    expect(staleDots(after)).toEqual([]);
    // lifting merges the two pieces back into one vertical wire
    const lifted = liftFromWires(after, sym, d.lookupBlock);
    const merged = lifted.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.x - 4) < 1e-9 && Math.abs(e.b.x - 4) < 1e-9);
    expect(merged).toHaveLength(1);
    expect([Math.max(merged[0]!.a.y, merged[0]!.b.y), Math.min(merged[0]!.a.y, merged[0]!.b.y)]).toEqual([8, 6]);
  });
  it('treats a horizontal symbol rotated -90 degrees as a vertical one', () => {
    const { d } = tee();
    const sym = ins('HPB11_NO', 4, 7, { TAG1: 'PB1' }, -Math.PI / 2);
    expect(worldConnections(sym, d.lookupBlock).every((c) => !c.horizontal)).toBe(true);
    expect(connectionColumns(sym, d.lookupBlock)).toEqual([4]);
    const after = breakForInsert([...d.entities, sym], sym, d.lookupBlock);
    expect(after.filter((e) => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.x - 4) < 1e-9 && Math.abs(e.b.x - 4) < 1e-9)).toHaveLength(2);
    expect(staleDots(after)).toEqual([]);
  });
  it('relocates a vertical symbol along its wire, re-breaking the wire there', () => {
    const { d } = tee();
    const sym = ins('USER_VLS_NO', 4, 7, { TAG1: 'LS1' });
    d.addEntities([sym]);
    d.transact((s) => ({ ...s, entities: breakForInsert(s.entities, sym, d.lookupBlock) }));
    const r = relocateComponent(d.entities, sym, d.lookupBlock, { x: 4, y: 6.6 });
    applyWireEdit(d, r, [r.moved]);
    const verticals = d.entities.filter((e): e is LineEntity => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.x - 4) < 1e-9);
    expect(verticals.map((w) => [Math.max(w.a.y, w.b.y), Math.min(w.a.y, w.b.y)]).sort((p, q) => q[0]! - p[0]!)).toEqual([
      [8, 6.975],
      [6.225, 6],
    ]);
  });
});

describe('vertical variant of a horizontal symbol', () => {
  it('names the twin the ACADE way', () => {
    expect(verticalVariantName('HPB11_NO')).toBe('VPB11_NO');
    expect(verticalVariantName('IEC_S_PB_NO')).toBe('IEC_S_PB_NO_V');
    expect(verticalVariantName('USER_PB1')).toBe('USER_PB1_V');
  });
  it('rotates the geometry -90 degrees, recodes the pins and keeps TAG1 readable to the right', () => {
    const h = findSymbol('HPB11_NO')!;
    const v = verticalVariant(h);
    expect(v.name).toBe('VPB11_NO');
    expect(isVerticalBlock(v)).toBe(true);
    expect(v.entities).toHaveLength(h.entities.length);
    const pins = v.attributes.filter((a) => pinDir(a.tag) !== null).map((a) => [a.tag, a.default, a.position.x, a.position.y]);
    expect(pins.map((p) => [p[0], p[1], Math.round((p[2] as number) * 1000) / 1000 + 0, Math.round((p[3] as number) * 1000) / 1000 + 0])).toEqual([
      ['X2TERM01', '13', 0, 0.375],
      ['X8TERM02', '14', 0, -0.375],
    ]);
    const tag = v.attributes.find((a) => a.tag === 'TAG1')!;
    expect(tag.rotation).toBeUndefined();
    expect(tag.align).toBe('left');
    expect(tag.position.x).toBeGreaterThan(0.1);
    expect(v.attributes.find((a) => a.tag === 'DESC1')!.position.y).toBeLessThan(tag.position.y);
    // the horizontal stubs became vertical ones on the axis
    expect(connectionPoints(v).map((c) => c.tag)).toEqual(['X2TERM01', 'X8TERM02']);
    // invisible data attributes are all still there
    for (const t of ['INST', 'LOC', 'MFG', 'CAT', 'WDTYPE']) expect(v.attributes.some((a) => a.tag === t && a.invisible)).toBe(true);
  });
});

describe('icon menu orientation', () => {
  it('normalises bare names and resolves V to a library twin or a generated block', () => {
    expect(symbolPick('HPB11_NO')).toEqual({ name: 'HPB11_NO', orientation: 'H' });
    expect(symbolPick(null)).toBeNull();
    const d = new Drawing();
    d.ensureBlocks(ALL_SYMBOLS);
    const h = resolveSymbolPick(d, { name: 'HPB11_NO', orientation: 'H' })!;
    expect(h.def.name).toBe('HPB11_NO');
    expect(h.note).toBeNull();
    const generated = resolveSymbolPick(d, { name: 'HPB11_NO', orientation: 'V' })!;
    expect(generated.def.name).toBe('VPB11_NO');
    expect(generated.note).toMatch(/rotated -90/);
    // a vertical symbol picked as vertical is inserted as is
    d.ensureBlocks([verticalSwitch()]);
    expect(resolveSymbolPick(d, { name: 'USER_VLS_NO', orientation: 'V' })!.note).toBeNull();
    // once the drawing (or the library) has the twin, it is used instead of generating one
    d.ensureBlocks([{ ...verticalVariant(findSymbol('HPB11_NO')!), description: 'Push button NO, vertical (library)' }]);
    const twin = resolveSymbolPick(d, { name: 'HPB11_NO', orientation: 'V' })!;
    expect(twin.def.description).toBe('Push button NO, vertical (library)');
    expect(twin.note).toBe('Vertical: VPB11_NO inserted for HPB11_NO.');
    expect(resolveSymbolPick(d, { name: 'NOPE', orientation: 'H' })).toBeNull();
  });

  it('inserts the generated V block on a vertical wire and says so in the command log', async () => {
    const d = new Drawing();
    d.addEntities([wire(1, 8, 9, 8), wire(4, 8, 4, 6), wireDot({ x: 4, y: 8 })]);
    const ctx = fakeContext(d);
    ctx.ui.pickSymbol = async () => ({ name: 'HPB11_NO', orientation: 'V' });
    ctx.ui.editComponent = async (init) => ({ tag: init.tag || 'PB1', desc: 'UP', mfg: '', cat: '' });
    const tool = new ComponentTool();
    tool.start(ctx);
    await tick();
    expect(d.blocks.VPB11_NO).toBeDefined();
    expect(ctx.logs.some((l) => l.includes('no VPB11_NO in the library') && l.includes('rotated -90'))).toBe(true);
    tool.onMove({ x: 4.02, y: 7 }, ctx);
    expect(ctx.preview[0]?.type === 'insert' && ctx.preview[0].position).toEqual({ x: 4, y: 7 });
    tool.onPoint({ x: 4.02, y: 7 }, ctx);
    await tick();
    const placed = d.entities.find((e): e is InsertEntity => e.type === 'insert' && e.block === 'VPB11_NO');
    expect(placed).toBeDefined();
    expect(placed!.position).toEqual({ x: 4, y: 7 });
    expect(placed!.rotation).toBe(0);
    // the generated twin tags like its horizontal source (PB, not DEV)
    expect(placed!.attributes.TAG1).toBe('PB1');
    expect(tagPrefix('VPB11_NO')).toBe('PB');
    // the vertical wire is broken around the symbol, the tee dot stays
    expect(d.entities.filter((e) => e.type === 'line' && e.layer === 'WIRES' && Math.abs(e.a.x - 4) < 1e-9 && Math.abs(e.b.x - 4) < 1e-9)).toHaveLength(2);
    expect(staleDots(d.entities)).toEqual([]);
    expect(ctx.finished).toBe(true);
  });

  it('inserts the library twin when one exists', async () => {
    const d = new Drawing();
    d.ensureBlocks([{ ...verticalVariant(findSymbol('HPB11_NO')!), description: 'twin' }]);
    const ctx = fakeContext(d);
    ctx.ui.pickSymbol = async () => ({ name: 'HPB11_NO', orientation: 'V' });
    new ComponentTool().start(ctx);
    await tick();
    expect(ctx.logs).toContain('Vertical: VPB11_NO inserted for HPB11_NO.');
    expect(ctx.prompts.at(-1)).toBe('Specify insertion point for VPB11_NO:');
  });
});

describe('definition precedence', () => {
  it('the drawing\'s own block definition wins over the library copy in the component tool', async () => {
    const d = new Drawing();
    // A drawing-private HPB11_NO with no attributes at all: the tool must not ask for a tag.
    d.ensureBlocks([{ name: 'HPB11_NO', basePoint: { x: 0, y: 0 }, entities: [line(-0.375, 0, 0.375, 0)], attributes: [] }]);
    d.addEntities([wire(1, 8, 9, 8)]);
    const ctx = fakeContext(d);
    let asked = false;
    ctx.ui.editComponent = async (init) => {
      asked = true;
      return { tag: init.tag, desc: '', mfg: '', cat: '' };
    };
    const tool = new ComponentTool('HPB11_NO');
    tool.start(ctx);
    await tick();
    tool.onPoint({ x: 5, y: 8 }, ctx);
    await tick();
    const placed = d.entities.find((e): e is InsertEntity => e.type === 'insert');
    expect(placed).toBeDefined();
    expect(asked).toBe(false);
    expect(placed!.attributes.TAG1).toBeUndefined();
    expect(d.blocks.HPB11_NO!.attributes).toHaveLength(0);
    expect(findSymbol('HPB11_NO')!.attributes.length).toBeGreaterThan(0);
  });
});
