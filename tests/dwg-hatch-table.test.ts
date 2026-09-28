import { describe, it, expect } from 'vitest';
import { convertDwg, convertHatch, type DwgImportPayload } from '../src/io/dwg';

const hatch = (extra: Record<string, unknown>) => ({ type: 'HATCH', handle: 'H1', layer: 'FILL', colorIndex: 1, ...extra }) as unknown as Parameters<typeof convertHatch>[0];

describe('DWG HATCH and ACAD_TABLE import', () => {
  it('turns a solid hatch into a filled outer polyline and outlined islands', () => {
    const parts = convertHatch(
      hatch({
        solidFill: 1,
        patternName: 'SOLID',
        boundaryPaths: [
          { boundaryPathTypeFlag: 7, vertices: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] },
          { boundaryPathTypeFlag: 2, vertices: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }, { x: 1, y: 2 }] },
        ],
      }),
    );
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatchObject({ type: 'polyline', closed: true, filled: true, layer: 'FILL' });
    expect(parts[1]).toMatchObject({ type: 'polyline', closed: true });
    expect((parts[1] as { filled?: boolean }).filled).toBeUndefined();
    expect(parts[0]!.id).not.toBe(parts[1]!.id);
  });
  it('samples edge-defined boundaries (line + arc) and keeps pattern hatches as outlines', () => {
    const parts = convertHatch(
      hatch({
        solidFill: 0,
        patternName: 'ANSI31',
        boundaryPaths: [
          {
            boundaryPathTypeFlag: 1,
            edges: [
              { type: 1, start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
              { type: 2, center: { x: 2, y: 1 }, radius: 1, startAngle: 270, endAngle: 90, isCounterClockwise: 1 },
              { type: 1, start: { x: 2, y: 2 }, end: { x: 0, y: 2 } },
            ],
          },
        ],
      }),
    );
    expect(parts).toHaveLength(1);
    const p = parts[0]!;
    if (p.type !== 'polyline') throw new Error('expected polyline');
    expect(p.filled).toBeUndefined();
    expect(p.points.length).toBeGreaterThan(6);
    expect(p.points.some((q) => Math.abs(q.x - 3) < 1e-6 && Math.abs(q.y - 1) < 1e-6)).toBe(true); // arc apex
  });
  it('draws an ACAD_TABLE through its *T block, matched by handle or handed out in order', () => {
    const payload: DwgImportPayload = {
      header: {},
      layers: [{ name: '0', colorIndex: 7 } as never],
      blocks: [
        { name: '*MODEL_SPACE', basePoint: { x: 0, y: 0 }, entities: [], description: '' } as never,
        { name: '*T7', handle: 'B853', basePoint: { x: 0, y: 0 }, entities: [{ type: 'LINE', handle: 'L1', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 5, y: 0 } }], description: '' } as never,
        { name: '*T9', handle: 'B999', basePoint: { x: 0, y: 0 }, entities: [{ type: 'LINE', handle: 'L2', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 0 } }], description: '' } as never,
      ],
      entities: [
        { type: 'ACAD_TABLE', handle: 'T1', layer: '0', blockRecordHandle: 'B853', startPoint: { x: 10, y: 20 }, rowCount: 3 } as never,
        { type: 'ACAD_TABLE', handle: 'T2', layer: '0', blockRecordHandle: '', startPoint: { x: 0, y: 0 }, rowCount: 0 } as never,
      ],
      version: 'r2018',
    };
    const { state, skipped, notes } = convertDwg(payload);
    const inserts = state.entities.filter((e) => e.type === 'insert');
    expect(skipped.ACAD_TABLE).toBeUndefined();
    expect(inserts.map((i) => (i.type === 'insert' ? i.block : null))).toEqual(['ANON_T7', 'ANON_T9']);
    const [first, second] = inserts;
    if (first?.type === 'insert') expect(first.position).toEqual({ x: 10, y: 20 });
    // The second table had no readable position: it is parked to the right of the first one, not at 0,0.
    if (second?.type === 'insert') expect(second.position.x).toBeGreaterThan(15);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('ANON_T9');
    expect(notes[0]).toContain('to the right of the drawing');
    expect(state.blocks.ANON_T7?.entities).toHaveLength(1);
  });
});

describe('table placement and DXF ACAD_TABLE', () => {
  it('places an unpositioned table inside the largest block reference (the sheet border)', async () => {
    const { convertDwg: conv } = await import('../src/io/dwg');
    const payload = {
      header: {},
      layers: [{ name: '0', colorIndex: 7 }],
      blocks: [
        { name: 'BORDER', basePoint: { x: 0, y: 0 }, entities: [{ type: 'LWPOLYLINE', handle: 'P1', layer: '0', flag: 1, vertices: [{ x: 0, y: 0, bulge: 0 }, { x: 34, y: 0, bulge: 0 }, { x: 34, y: 22, bulge: 0 }, { x: 0, y: 22, bulge: 0 }] }], description: '' },
        { name: '*T4', handle: 'B853', basePoint: { x: 0, y: 0 }, entities: [{ type: 'LINE', handle: 'L1', layer: '0', startPoint: { x: 0, y: 0 }, endPoint: { x: 25, y: -19 } }], description: '' },
      ],
      entities: [
        { type: 'INSERT', handle: 'I1', layer: '0', name: 'BORDER', insertionPoint: { x: 1, y: 1 }, xScale: 1, yScale: 1, rotation: 0 },
        { type: 'ACAD_TABLE', handle: 'T2', layer: '0', blockRecordHandle: '', startPoint: { x: 0, y: 0 }, rowCount: 0 },
      ],
      version: 'r2018',
    } as unknown as Parameters<typeof conv>[0];
    const { state, notes } = conv(payload);
    const table = state.entities.find((e) => e.type === 'insert' && e.block === 'ANON_T4');
    expect(table).toBeDefined();
    if (table?.type === 'insert') {
      // Sheet spans x 1..35, y 1..23; margin 3% of 34 = 1.02: table top-left at (2.02, 21.98).
      expect(table.position.x).toBeCloseTo(2.02, 2);
      expect(table.position.y).toBeCloseTo(21.98, 2);
    }
    expect(notes[0]).toContain('inside the sheet border');
  });
  it('reads ACAD_TABLE from DXF as an insert of its *T block at the exact position', async () => {
    const { readDxf, writeDxf } = await import('../src/io/dxf');
    const dxf = [
      '0', 'SECTION', '2', 'BLOCKS',
      '0', 'BLOCK', '8', '0', '2', '*T9', '70', '1', '10', '0', '20', '0', '3', '*T9',
      '0', 'LINE', '8', '0', '10', '0', '20', '0', '11', '5', '21', '0',
      '0', 'ENDBLK',
      '0', 'ENDSEC',
      '0', 'SECTION', '2', 'ENTITIES',
      '0', 'ACAD_TABLE', '8', 'TBL', '2', '*T9', '10', '3.5', '20', '20', '30', '0', '11', '1', '21', '0', '31', '0',
      '0', 'ENDSEC',
      '0', 'EOF', '',
    ].join('\n');
    const state = readDxf(dxf);
    const ins = state.entities.find((e) => e.type === 'insert');
    expect(ins).toMatchObject({ type: 'insert', block: '*T9', position: { x: 3.5, y: 20 }, layer: 'TBL' });
    expect(state.blocks['*T9']?.entities).toHaveLength(1);
    // Written back, the anonymous block carries flag 1.
    expect(writeDxf(state)).toMatch(/\n2\r?\n\*T9\r?\n70\r?\n1\r?\n/);
  });
});
