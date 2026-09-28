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
    expect(inserts.map((i) => (i.type === 'insert' ? [i.block, i.position.x, i.position.y] : null))).toEqual([
      ['ANON_T7', 10, 20],
      ['ANON_T9', 0, 0],
    ]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('ANON_T9');
    expect(state.blocks.ANON_T7?.entities).toHaveLength(1);
  });
});
