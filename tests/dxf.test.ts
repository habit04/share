import { describe, it, expect } from 'vitest';
import { writeDxf, readDxf } from '../src/io/dxf';
import { Drawing } from '../src/core/document';
import type { Entity } from '../src/core/entities';
import { ALL_SYMBOLS, findSymbol } from '../src/electrical/symbols';

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
      expect(ins.attributes).toEqual({ TAG1: 'PB101', DESC1: 'START' });
    }
    // Block definitions survive with their attribute definitions
    const blk = state.blocks.HPB11_NO!;
    expect(blk).toBeDefined();
    expect(blk.entities.length).toBe(findSymbol('HPB11_NO')!.entities.length);
    expect(blk.attributes.map((a) => a.tag)).toEqual(['TAG1', 'DESC1']);
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
});
