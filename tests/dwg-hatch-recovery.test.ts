import { describe, expect, it } from 'vitest';
import { convertDwg, convertHatchEntity, type DwgImportPayload } from '../src/io/dwg';
import { readDxf, writeDxf } from '../src/io/dxf';

const line = (x: number) => ({ type: 1, start: { x, y: 0 }, end: { x: x + 1, y: 0 } });
const square = (min: number, max: number) => ({
  boundaryPathTypeFlag: 2,
  vertices: [{ x: min, y: min }, { x: max, y: min }, { x: max, y: max }, { x: min, y: max }],
});
const hatch = (boundaryPaths: unknown[]) => ({ type: 'HATCH', handle: '206D5', layer: 'FILL', solidFill: 1, patternName: 'SOLID', boundaryPaths });
const payload = (entities: unknown[], blocks: unknown[] = []) => ({ header: {}, layers: [], blocks, entities }) as DwgImportPayload;

describe('DWG hatch boundary recovery', () => {
  it.each([undefined, null, { type: 0 }])('opens a drawing containing an undecoded edge (%j), with a source warning and no invented closure', (missing) => {
    const source = hatch([{ numberOfEdges: 3, edges: [line(0), missing, line(4)] }]);
    const { state, skipped, report } = convertDwg(payload([
      source,
      { type: 'LINE', layer: '0', startPoint: { x: 10, y: 0 }, endPoint: { x: 11, y: 0 } },
    ]));
    expect(skipped.HATCH).toBeUndefined();
    expect(state.entities.filter((e) => e.type === 'line')).toHaveLength(1);
    const outlines = state.entities.filter((e) => e.type === 'polyline');
    expect(outlines).toHaveLength(2);
    expect(outlines.map((e) => e.points)).toEqual([[{ x: 0, y: 0 }, { x: 1, y: 0 }], [{ x: 4, y: 0 }, { x: 5, y: 0 }]]);
    for (const e of outlines) {
      expect(e.closed).toBe(false);
      expect(e.filled).toBeUndefined();
    }
    expect(report?.items).toContainEqual(expect.objectContaining({
      type: 'HATCH', action: 'simplified', handle: '206D5', layer: 'FILL', where: 'model space',
      reason: expect.stringContaining('did not decode 1 hatch boundary edge(s)'),
    }));
    const back = readDxf(writeDxf(state));
    expect(back.entities.filter((e) => e.type === 'polyline').every((e) => !e.closed && !e.filled)).toBe(true);
  });

  it('preserves complete hatch loops and their hole', () => {
    const { state, report } = convertDwg(payload([hatch([square(0, 10), square(2, 4)])]));
    expect(state.entities).toHaveLength(1);
    expect(state.entities[0]).toMatchObject({ type: 'hatch', solid: true, loops: [{ points: square(0, 10).vertices }, { points: square(2, 4).vertices }] });
    expect(report?.items.filter((e) => e.type === 'HATCH')).toEqual([]);
  });

  it('removes fill from the whole hatch when its hole is incomplete, while keeping the complete outer outline', () => {
    const source = hatch([square(0, 10), { numberOfEdges: 4, edges: [line(2), undefined] }]);
    expect(convertHatchEntity(source as never)).toBeNull();
    const { state, report } = convertDwg(payload([source]));
    expect(state.entities).toHaveLength(2);
    expect(state.entities[0]).toMatchObject({ type: 'polyline', closed: true, points: square(0, 10).vertices });
    expect(state.entities[1]).toMatchObject({ type: 'polyline', closed: false });
    expect(state.entities.every((e) => e.type === 'polyline' && !e.filled)).toBe(true);
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'HATCH', reason: expect.stringContaining('did not decode 3 hatch boundary edge(s)') }));
  });

  it('keeps the decoded spline before sparse native segments and reports a completely unreadable block hatch', () => {
    const spline = { type: 4, degree: 3, knots: [0, 0, 0, 0, 1, 1, 1, 1], controlPoints: [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 0 }] };
    const source = hatch([{ edges: [spline, ...new Array(3)] }]);
    const { state, skipped, report } = convertDwg(payload([source], [{ name: 'SIGNATURE', basePoint: { x: 0, y: 0 }, entities: [hatch([{ edges: [null, undefined] }])] }]));
    expect(state.entities).toHaveLength(1);
    const curve = state.entities[0];
    if (curve?.type !== 'polyline') throw new Error('expected recovered curve');
    expect(curve.closed).toBe(false);
    expect(curve.points[0]).toEqual({ x: 0, y: 0 });
    expect(curve.points.at(-1)).toEqual({ x: 3, y: 0 });
    expect(curve.points.length).toBeGreaterThan(4);
    expect(skipped.HATCH).toBe(1);
    expect(state.blocks.SIGNATURE?.entities).toEqual([]);
    expect(report?.items).toContainEqual(expect.objectContaining({ type: 'HATCH', action: 'dropped', handle: '206D5', where: 'block "SIGNATURE"', reason: expect.stringContaining('no usable outline geometry') }));
  });
});
