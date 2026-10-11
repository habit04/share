import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

type Pair = readonly [number, string];
const polyline: Pair[] = [[91, '1'], [92, '2'], [72, '0'], [73, '1'], [93, '2'], [10, '0'], [20, '0'], [10, '1'], [20, '0'], [97, '0']];
const lineEdge: Pair[] = [[91, '1'], [92, '1'], [93, '1'], [72, '1'], [10, '0'], [20, '0'], [11, '1'], [21, '0'], [97, '0']];
const splineEdge: Pair[] = [[91, '1'], [92, '1'], [93, '1'], [72, '4'], [94, '1'], [73, '0'], [74, '0'], [95, '4'], [96, '2'], [40, '0'], [40, '0'], [40, '1'], [40, '1'], [10, '0'], [20, '0'], [10, '1'], [20, '0'], [97, '0'], [97, '0']];
const pattern: Pair[] = [...polyline, [75, '0'], [76, '1'], [52, '0'], [41, '1'], [77, '0'], [78, '1'], [53, '45'], [43, '0'], [44, '0'], [45, '1'], [46, '1'], [79, '1'], [49, '1']];
const dxf = (pairs: readonly Pair[]) => [[0, 'SECTION'], [2, 'ENTITIES'], [0, 'HATCH'], [5, 'AA'], [8, 'HATCH_TEST'], [2, 'SOLID'], [70, '1'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']].flat().join('\n');
function replaceCount(pairs: readonly Pair[], code: number, value: string, occurrence = 0): Pair[] {
  let seen = 0;
  return pairs.map((p) => p[0] === code && seen++ === occurrence ? [code, value] : p);
}

// Keep nontermination/OOM regressions outside Vitest's worker. The child is killed on a
// timeout and has a small heap limit; the harness reports the failure without hanging CI.
const childBundle = buildSync({
  stdin: { contents: `import { readDxf } from './src/io/dxf'; import { convertDwg, convertHatch } from './src/io/dwg'; import { importReportOf } from './src/io/import-report'; import { nurbsPoints, interpolateFitPoints } from './src/core/spline'; globalThis.hatchTestApi = { readDxf, convertDwg, convertHatch, importReportOf, nurbsPoints, interpolateFitPoints };`, resolveDir: fileURLToPath(new URL('..', import.meta.url)), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', loader: { '.jhf': 'text' }, write: false, logLevel: 'silent',
}).outputFiles[0]!.text;
function childResult<T>(body: string): T {
  const result = spawnSync(process.execPath, ['--max-old-space-size=96', '--input-type=commonjs', '-'], {
    input: `${childBundle}\nconst api = globalThis.hatchTestApi;\n${body}`,
    encoding: 'utf8', timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as T;
}

describe('bounded hatch import', () => {
  it('rejects every malformed or oversized DXF collection before iterating it', () => {
    const sites = [
      { name: 'paths', pairs: polyline, code: 91 },
      { name: 'polyline vertices', pairs: polyline, code: 93 },
      { name: 'polyline source handles', pairs: polyline, code: 97 },
      { name: 'edges', pairs: lineEdge, code: 93 },
      { name: 'edge source handles', pairs: lineEdge, code: 97 },
      { name: 'spline knots', pairs: splineEdge, code: 95 },
      { name: 'spline controls', pairs: splineEdge, code: 96 },
      { name: 'spline fit points', pairs: splineEdge, code: 97 },
      { name: 'spline source handles', pairs: splineEdge, code: 97, occurrence: 1 },
      { name: 'pattern lines', pairs: pattern, code: 78 },
      { name: 'pattern dashes', pairs: pattern, code: 79 },
    ];
    const cases = sites.flatMap((site) => ['1e309', '1e9', '1000000000', 'Infinity', '9007199254740991', '-1', '1.5', '1junk'].map((value) => ({ name: `${site.name}: ${value}`, code: site.code, text: dxf(replaceCount(site.pairs, site.code, value, site.occurrence)) })));
    const results = childResult<Array<{ count: number; item: { type: string; action: string; handle: string; layer: string; where: string; line: number; reason: string } }>>(`const cases = ${JSON.stringify(cases)}; console.log(JSON.stringify(cases.map(c => { const state = api.readDxf(c.text); return { count: state.entities.length, item: api.importReportOf(state)?.items[0] }; })));`);
    for (let i = 0; i < cases.length; i += 1) {
      expect(results[i], cases[i]!.name).toMatchObject({ count: 0, item: { type: 'HATCH', action: 'dropped', handle: 'AA', layer: 'HATCH_TEST', where: 'model space', line: 5 } });
      expect(results[i]!.item.reason, cases[i]!.name).toMatch(new RegExp(`group ${cases[i]!.code}.*value line`));
    }
  }, 10000);

  it('rejects bounded counts whose required structural records are absent', () => {
    const cases = [
      dxf([[91, '1'], [999, 'no boundary fields']]),
      dxf([[91, '1000000000'], [999, 'no boundary fields']]),
      dxf(replaceCount([...polyline, [999, 'not a source handle']], 97, '1')),
      dxf(replaceCount(polyline, 93, '3')),
      dxf(replaceCount(pattern, 79, '2')),
    ];
    const result = childResult<Array<{ count: number; reason: string }>>(`console.log(JSON.stringify(${JSON.stringify(cases)}.map(text => { const state = api.readDxf(text); return { count: state.entities.length, reason: api.importReportOf(state)?.items[0]?.reason }; })));`);
    for (const item of result) expect(item).toMatchObject({ count: 0, reason: expect.stringContaining('invalid hatch data') });
  }, 10000);

  it('still imports ordinary polyline, edge and spline boundaries', () => {
    const result = childResult<number[]>(`console.log(JSON.stringify(${JSON.stringify([polyline, lineEdge, splineEdge].map(dxf))}.map(text => api.readDxf(text).entities.length)));`);
    expect(result).toEqual([1, 1, 1]);
  }, 10000);

  it('drops overflowing DWG boundaries with a source warning instead of allocating an outline', () => {
    const edges = [
      { type: 2, center: { x: 1e308, y: 0 }, radius: 1e308, startAngle: 0, endAngle: 1e12 },
      { type: 3, center: { x: 1e308, y: 0 }, majorAxis: { x: 1e308, y: 0 }, minorAxisRatio: 1, startAngle: 0, endAngle: 1e12 },
      { type: 3, center: { x: 0, y: 0 }, majorAxis: { x: 1e308, y: 1e308 }, minorAxisRatio: 1e308, startAngle: 0, endAngle: 1e12 },
    ];
    const result = childResult<Array<{ count: number; items: Array<{ type: string; action: string; handle: string; where: string; reason: string }> }>>(`console.log(JSON.stringify(${JSON.stringify(edges)}.map(edge => { const result = api.convertDwg({ header: {}, layers: [], blocks: [], entities: [{ type: 'HATCH', handle: 'BAD', layer: '0', solidFill: true, boundaryPaths: [{ edges: [edge] }] }] }); return { count: result.state.entities.length, items: result.report?.items }; })));`);
    for (const item of result) {
      expect(item.count).toBe(0);
      expect(item.items).toContainEqual(expect.objectContaining({ type: 'HATCH', action: 'dropped', handle: 'BAD', where: 'model space', reason: expect.stringContaining('non-finite coordinate derived') }));
    }
  }, 10000);

  it('caps sampled DWG arcs and ellipses for huge finite angles and retains normal bounds', () => {
    const edges = [
      { type: 2, center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: 1e12 },
      { type: 3, center: { x: 0, y: 0 }, majorAxis: { x: 4, y: 0 }, minorAxisRatio: 0.5, startAngle: 0, endAngle: 1e12 },
      { type: 2, center: { x: 0, y: 0 }, radius: 10, startAngle: 1e308, endAngle: -1e308 },
      { type: 3, center: { x: 0, y: 0 }, majorAxis: { x: 4, y: 0 }, minorAxisRatio: 0.5, startAngle: 1e308, endAngle: -1e308 },
      { type: 2, center: { x: 0, y: 0 }, radius: 10, startAngle: 0, endAngle: Math.PI / 2 },
      { type: 3, center: { x: 0, y: 0 }, majorAxis: { x: 4, y: 0 }, minorAxisRatio: 0.5, startAngle: 0, endAngle: 2 * Math.PI },
    ];
    const result = childResult<Array<{ points: Array<{ x: number; y: number }>; native: string }>>(`console.log(JSON.stringify(${JSON.stringify(edges)}.map(edge => { const e = { type: 'HATCH', layer: '0', solidFill: true, boundaryPaths: [{ edges: [edge] }] }; const parts = api.convertHatch(e); const result = api.convertDwg({ header: {}, layers: [], blocks: [], entities: [e] }); return { points: parts[0]?.points, native: result.state.entities[0]?.type }; })));`);
    for (const item of result) {
      expect(item.native).toBe('hatch');
      expect(item.points.length).toBeLessThanOrEqual(65);
      expect(item.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    }
    expect(result[4]!.points[0]).toMatchObject({ x: 10, y: 0 });
    expect(result[4]!.points.at(-1)!.x).toBeCloseTo(0);
    expect(result[4]!.points.at(-1)!.y).toBeCloseTo(10);
    expect(Math.min(...result[5]!.points.map((p) => p.x))).toBeCloseTo(-4);
    expect(Math.max(...result[5]!.points.map((p) => p.x))).toBeCloseTo(4);
    expect(Math.min(...result[5]!.points.map((p) => p.y))).toBeCloseTo(-2);
    expect(Math.max(...result[5]!.points.map((p) => p.y))).toBeCloseTo(2);
  }, 10000);

  it('bounds NURBS degree work and dense fit interpolation for DXF/DWG HATCH and SPLINE', () => {
    const result = childResult<Array<{ format: string; type: string; name: string; count: number; item: { type: string; action: string; handle: string; layer: string; where: string; reason: string } }>>(`
      const degree = 6000;
      const high = { name: 'high degree', degree, controlPoints: Array.from({ length: degree + 1 }, (_, i) => ({ x: i, y: 0 })), knots: [...Array(degree + 1).fill(0), ...Array(degree + 1).fill(1)], fitPoints: [] };
      const dense = { name: 'dense fits', degree: 3, controlPoints: [], knots: [], fitPoints: Array.from({ length: 3500 }, (_, i) => ({ x: i, y: i % 3 })) };
      const outputs = [];
      for (const source of [high, dense]) for (const type of ['HATCH', 'SPLINE']) {
        let pairs = type === 'HATCH' ? [[2, 'SOLID'], [70, 1], [91, 1], [92, 1], [93, 1], [72, 4], [94, source.degree], [73, 0], [74, 0], [95, source.knots.length], [96, source.controlPoints.length]] : [[70, 0], [71, source.degree], [72, source.knots.length], [73, source.controlPoints.length], [74, source.fitPoints.length]];
        pairs.push(...source.knots.map(k => [40, k]));
        for (const p of source.controlPoints) pairs.push([10, p.x], [20, p.y]);
        if (type === 'HATCH') pairs.push([97, source.fitPoints.length]);
        for (const p of source.fitPoints) pairs.push([11, p.x], [21, p.y]);
        if (type === 'HATCH') pairs.push([97, 0]);
        const text = [[0, 'SECTION'], [2, 'ENTITIES'], [0, type], [5, 'WORK'], [8, 'SPLINE_TEST'], ...pairs, [0, 'ENDSEC'], [0, 'EOF']].flat().join('\\n');
        const state = api.readDxf(text);
        outputs.push({ format: 'DXF', type, name: source.name, count: state.entities.length, item: api.importReportOf(state)?.items[0] });
        const data = type === 'HATCH' ? { solidFill: true, boundaryPaths: [{ edges: [{ type: 4, ...source }] }] } : source;
        const converted = api.convertDwg({ header: {}, layers: [], blocks: [], entities: [{ type, handle: 'WORK', layer: 'SPLINE_TEST', ...data }] });
        outputs.push({ format: 'DWG', type, name: source.name, count: converted.state.entities.length, item: converted.report?.items.find(i => i.type === type && i.action === 'dropped') });
      }
      console.log(JSON.stringify(outputs));
    `);
    expect(result).toHaveLength(8);
    for (const item of result) {
      expect(item, `${item.format} ${item.type} ${item.name}`).toMatchObject({ count: 0, item: { type: item.type, action: 'dropped', handle: 'WORK', layer: 'SPLINE_TEST', where: 'model space', reason: expect.stringContaining('supported work limit') } });
      expect(item.item.reason).toContain(item.name === 'high degree' ? 'tessellation' : 'fit interpolation');
    }
  }, 10000);

  it('defensively avoids costly spline work for callers outside the import path', () => {
    const result = childResult<{ polygonLength: number; interpolated: null; ordinaryLength: number }>(`
      const degree = 6000;
      const curve = { degree, controlPoints: Array.from({ length: degree + 1 }, (_, i) => ({ x: i, y: 0 })), knots: [...Array(degree + 1).fill(0), ...Array(degree + 1).fill(1)] };
      const largeFit = Array.from({ length: 3500 }, (_, i) => ({ x: i, y: i % 3 }));
      const ordinary = api.interpolateFitPoints([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 2, y: 0 }, { x: 3, y: 1 }]);
      console.log(JSON.stringify({ polygonLength: api.nurbsPoints(curve).length, interpolated: api.interpolateFitPoints(largeFit), ordinaryLength: api.nurbsPoints(ordinary).length }));
    `);
    expect(result.polygonLength).toBe(6001);
    expect(result.interpolated).toBeNull();
    expect(result.ordinaryLength).toBeGreaterThan(4);
  }, 10000);
});
