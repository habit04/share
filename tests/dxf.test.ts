import { describe, it, expect } from 'vitest';
import { writeDxf, readDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { polylineVertices } from '../src/core/entities';
import { ALL_SYMBOLS, findSymbol } from '../src/electrical/symbols';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function sample(): Drawing {
  const d = new Drawing();
  d.ensureBlocks(ALL_SYMBOLS);
  const ents: Entity[] = [
    { id: '1', layer: 'WIRES', color: 'ByLayer', type: 'line', a: { x: 0, y: 0 }, b: { x: 9, y: 0 } },
    { id: '2', layer: '0', color: 1, type: 'circle', center: { x: 1.5, y: 2.25 }, radius: 0.75 },
    { id: '3', layer: 'MISC', color: 'ByLayer', type: 'arc', center: { x: 0, y: 0 }, radius: 2, startAngle: Math.PI / 6, endAngle: Math.PI },
    { id: '4', layer: 'MISC', color: 'ByLayer', type: 'polyline', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true },
    { id: '5', layer: 'TAGS', color: 'ByLayer', type: 'text', position: { x: 2, y: 3 }, text: 'START', height: 0.125, rotation: 0, align: 'center' },
    { id: '6', layer: 'SYMS', color: 'ByLayer', type: 'insert', block: 'HPB11_NO', position: { x: 4, y: 0 }, rotation: 0, scale: 1, attributes: { TAG1: 'PB101', DESC1: 'START' } },
  ];
  d.addEntities(ents);
  return d;
}

describe('DXF round trip', () => {
  it('writes a DXF with the expected sections', () => {
    const text = writeDxf(sample().snapshot);
    expect(text).toContain('AC1015');
    for (const s of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES']) expect(text).toContain(`\r\n2\r\n${s}\r\n`);
    expect(text.trimEnd().endsWith('EOF')).toBe(true);
    expect(text).toContain('LWPOLYLINE');
    expect(text).toContain('HPB11_NO');
  });

  it('reads back what it wrote', () => {
    const src = sample();
    const state = readDxf(writeDxf(src.snapshot));
    expect(state.entities).toHaveLength(6);
    const types = state.entities.map((e) => e.type).sort();
    expect(types).toEqual(['arc', 'circle', 'insert', 'line', 'polyline', 'text']);

    const circle = state.entities.find((e) => e.type === 'circle');
    if (circle?.type === 'circle') {
      expect(circle.center).toEqual({ x: 1.5, y: 2.25 });
      expect(circle.radius).toBe(0.75);
      expect(circle.color).toBe(1);
    }
    const arc = state.entities.find((e) => e.type === 'arc');
    if (arc?.type === 'arc') {
      expect(arc.startAngle).toBeCloseTo(Math.PI / 6, 6);
      expect(arc.endAngle).toBeCloseTo(Math.PI, 6);
    }
    const pl = state.entities.find((e) => e.type === 'polyline');
    if (pl?.type === 'polyline') {
      expect(pl.closed).toBe(true);
      expect(pl.points).toHaveLength(3);
    }
    const txt = state.entities.find((e) => e.type === 'text');
    if (txt?.type === 'text') {
      expect(txt.text).toBe('START');
      expect(txt.align).toBe('center');
      expect(txt.position).toEqual({ x: 2, y: 3 });
    }
    const ins = state.entities.find((e) => e.type === 'insert');
    if (ins?.type === 'insert') {
      expect(ins.block).toBe('HPB11_NO');
      // the ACADE data / pin attributes come back too (with their defaults)
      expect(ins.attributes).toMatchObject({ TAG1: 'PB101', DESC1: 'START' });
      expect(ins.attributes.X1TERM01).toBeDefined();
    }
    // Block definitions survive with their attribute definitions
    const blk = state.blocks.HPB11_NO!;
    expect(blk).toBeDefined();
    expect(blk.entities.length).toBe(findSymbol('HPB11_NO')!.entities.length);
    expect(blk.attributes.map((a) => a.tag).slice(0, 2)).toEqual(['TAG1', 'DESC1']);
    expect(blk.attributes.map((a) => a.tag)).toContain('X1TERM01');
    // Layers round trip
    expect(state.layers.find((l) => l.name === 'WIRES')?.color).toBe(1);
    expect(state.currentLayer).toBe('0');
  });

  it('reads a minimal hand-written R12-style DXF', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'LINE', '8', 'A', '10', '1', '20', '2', '11', '3', '21', '4', '0', 'POLYLINE', '8', 'B', '70', '1', '0', 'VERTEX', '10', '0', '20', '0', '0', 'VERTEX', '10', '1', '20', '0', '0', 'VERTEX', '10', '1', '20', '1', '0', 'SEQEND', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const s = readDxf(dxf);
    expect(s.entities).toHaveLength(2);
    expect(s.entities[0]!.layer).toBe('A');
    const pl = s.entities[1]!;
    expect(pl.type).toBe('polyline');
    if (pl.type === 'polyline') expect(pl.points).toHaveLength(3);
    expect(s.layers.map((l) => l.name).sort()).toEqual(['0', 'A', 'B']);
  });

  it('writes the mandatory AC1015 tables and sections', () => {
    const text = writeDxf(sample().snapshot);
    for (const t of ['BLOCK_RECORD', 'LTYPE', 'STYLE', 'APPID', 'DIMSTYLE', 'VPORT']) expect(text).toContain(`\r\n2\r\n${t}\r\n`);
    expect(text).toContain('$HANDSEED');
    expect(text).toContain('*Model_Space');
    expect(text).toContain('\r\n2\r\nCLASSES\r\n');
    expect(text).toContain('\r\n2\r\nOBJECTS\r\n');
    // every block entity's owner must be a BLOCK_RECORD handle, never the model-space handle
    const blocksSection = text.slice(text.indexOf('\r\n2\r\nBLOCKS\r\n'), text.indexOf('\r\n2\r\nENTITIES\r\n'));
    expect(/\r\n330\r\n1F\r\n/.test(blocksSection.slice(blocksSection.indexOf('HPB11_NO')))).toBe(false);
  });

  it('parses MTEXT with attachment and direction vector', () => {
    const dxf = ['0', 'SECTION', '2', 'ENTITIES', '0', 'MTEXT', '8', '0', '10', '5', '20', '6', '40', '0.2', '71', '1', '11', '0.7071', '21', '0.7071', '1', '{\\fArial;Hello}\\PWorld', '0', 'ENDSEC', '0', 'EOF'].join('\n');
    const s = readDxf(dxf);
    const t = s.entities[0]!;
    expect(t.type).toBe('text');
    if (t.type === 'text') {
      expect(t.text).toBe('Hello World');
      expect(t.rotation).toBeCloseTo(Math.PI / 4, 3);
      expect(t.align).toBe('left');
      // top-left attachment: baseline is one text height below the corner, along the rotated up-vector
      expect(t.position.x).toBeCloseTo(5 + Math.sin(Math.PI / 4) * 0.2, 3);
      expect(t.position.y).toBeCloseTo(6 - Math.cos(Math.PI / 4) * 0.2, 3);
    }
  });

  it('honours invisible attributes, frozen/off layers and bulges', () => {
    const dxf = [
      '0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '0', 'LAYER', '2', 'HID', '70', '1', '62', '3', '0', 'LAYER', '2', 'OFF', '70', '0', '62', '-3', '0', 'ENDTAB', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B', '10', '0', '20', '0', '0', 'ATTDEF', '8', '0', '10', '0', '20', '0', '40', '0.1', '1', 'x', '3', 'p', '2', 'SECRET', '70', '1', '0', 'ENDBLK', '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'INSERT', '8', '0', '66', '1', '2', 'B', '10', '1', '20', '1', '0', 'ATTRIB', '8', '0', '10', '1', '20', '1', '40', '0.1', '1', 'hidden value', '2', 'SECRET', '70', '1', '0', 'SEQEND',
      '0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '2', '20', '0',
      '0', 'ENDSEC', '0', 'EOF',
    ].join('\n');
    const s = readDxf(dxf);
    expect(s.layers.find((l) => l.name === 'HID')?.visible).toBe(false);
    expect(s.layers.find((l) => l.name === 'OFF')?.visible).toBe(false);
    expect(s.blocks.B!.attributes[0]!.invisible).toBe(true);
    const ins = s.entities.find((e) => e.type === 'insert');
    if (ins?.type === 'insert') expect(ins.attributes.SECRET).toBe('hidden value');
    const pl = s.entities.find((e) => e.type === 'polyline');
    if (pl?.type === 'polyline') {
      expect(pl.points).toHaveLength(2); // the bulge is kept, not tessellated
      expect(pl.bulges?.[0]).toBe(1);
      const verts = polylineVertices(pl);
      expect(verts.length).toBeGreaterThan(5); // semicircle tessellated for display
      // positive bulge = counter-clockwise from (0,0) to (2,0): the arc passes below the chord
      const bottom = Math.min(...verts.map((p) => p.y));
      expect(bottom).toBeCloseTo(-1, 1);
    }
    // the invisible attribute must round-trip as invisible
    const again = readDxf(writeDxf(s));
    expect(again.blocks.B!.attributes[0]!.invisible).toBe(true);
  });

  it('round-trips the constant / verify / preset attribute flags (group 70 bits 2, 4, 8)', () => {
    const d = new Drawing();
    const at = (tag: string, flags: Record<string, boolean>) => ({ tag, prompt: tag, default: `${tag}-default`, position: { x: 0, y: 0 }, height: 0.1, align: 'left' as const, ...flags });
    d.defineBlock({
      name: 'FLAGS',
      basePoint: { x: 0, y: 0 },
      entities: [],
      attributes: [at('PLAIN', {}), at('HID', { invisible: true }), at('CONST', { constant: true }), at('VER', { verify: true }), at('PRE', { preset: true, invisible: true })],
    });
    d.addEntities([{ id: 'i', layer: '0', color: 'ByLayer', type: 'insert', block: 'FLAGS', position: { x: 1, y: 1 }, scale: 1, rotation: 0, attributes: { PLAIN: 'p', HID: 'h', VER: 'v', PRE: 's' } }]);
    const text = writeDxf(d.snapshot);
    const back = readDxf(text);
    const attrs = back.blocks.FLAGS!.attributes as unknown as ReadonlyArray<Record<string, unknown>>;
    const flags = (tag: string) => {
      const a = attrs.find((x) => x.tag === tag)!;
      return ['invisible', 'constant', 'verify', 'preset'].filter((k) => a[k] === true);
    };
    expect(flags('PLAIN')).toEqual([]);
    expect(flags('HID')).toEqual(['invisible']);
    expect(flags('CONST')).toEqual(['constant']);
    expect(flags('VER')).toEqual(['verify']);
    expect(flags('PRE')).toEqual(['invisible', 'preset']);
    // A constant attribute has no ATTRIB on the insert (its definition's value shows).
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const attribTags: string[] = [];
    let inAttrib = false;
    for (let i = 0; i + 1 < lines.length; i += 2) {
      if (lines[i] === '0') inAttrib = lines[i + 1] === 'ATTRIB';
      else if (inAttrib && lines[i] === '2') attribTags.push(lines[i + 1]!);
    }
    expect(attribTags).toEqual(['PLAIN', 'HID', 'VER', 'PRE']);
    const ins = back.entities.find((e) => e.type === 'insert');
    expect(ins?.type === 'insert' && ins.attributes).toEqual({ PLAIN: 'p', HID: 'h', VER: 'v', PRE: 's' });
    // Written again, the flags stay.
    const twice = readDxf(writeDxf(back)).blocks.FLAGS!.attributes as unknown as ReadonlyArray<Record<string, unknown>>;
    expect(twice.map((a) => [a.tag, !!a.constant, !!a.verify, !!a.preset])).toEqual([
      ['PLAIN', false, false, false],
      ['HID', false, false, false],
      ['CONST', true, false, false],
      ['VER', false, true, false],
      ['PRE', false, false, true],
    ]);
  });

  it('round-trips a filled wire dot as a donut', () => {
    const d = new Drawing();
    d.addEntities([{ id: 'dot', layer: 'WIRES', color: 'ByLayer', type: 'circle', center: { x: 3, y: 4 }, radius: 0.035, filled: true }]);
    const text = writeDxf(d.snapshot);
    expect(text).toContain('LWPOLYLINE');
    const back = readDxf(text);
    const c = back.entities[0]!;
    expect(c.type).toBe('circle');
    if (c.type === 'circle') {
      expect(c.filled).toBe(true);
      expect(c.center.x).toBeCloseTo(3);
      expect(c.radius).toBeCloseTo(0.035);
    }
  });

  const fixture = join(__dirname, '..', 'fixtures', 'example_2000.dxf');
  it.skipIf(!existsSync(fixture))('reads the LibreDWG example_2000.dxf fixture', () => {
    const s = readDxf(readFileSync(fixture, 'utf8'));
    expect(s.entities.length).toBeGreaterThan(30);
    expect(s.layers.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(s.blocks).length).toBeGreaterThanOrEqual(2);
    for (const e of s.entities) if (e.type === 'insert') expect(s.blocks[e.block]).toBeDefined();
  });
});
