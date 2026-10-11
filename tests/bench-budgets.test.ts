import { describe, expect, it } from 'vitest';
import { checkBrowserBudgets, checkProjectBudgets } from '../scripts/bench-budgets.mjs';
const sample = { entities: 50000, selected: 1693, coldStateLoad: 100, firstGeometry: 400, coldRender: 200, coldReady: 720, load: 110, renderExtents: 20, renderZoomed: 10, hover: 0.1, windowSelect: 17 };
describe('browser performance gate', () => {
  it('accepts baseline measurements and a bounded shared-runner multiplier', () => {
    expect(checkBrowserBudgets(sample)).toEqual([]);
    expect(checkBrowserBudgets({ ...sample, renderExtents: 75 }, 2)).toEqual([]);
  });
  it('rejects regressions and incomplete benchmark workloads', () => {
    expect(checkBrowserBudgets({ ...sample, entities: 4, selected: 0, hover: 40, load: NaN })).toHaveLength(4);
    for (const factor of [0, -1, Infinity, NaN, 11]) expect(() => checkBrowserBudgets(sample, factor)).toThrow(/JCAD_PERF_FACTOR/);
  });
  it('requires valid first-use timings instead of accepting only warmed measurements', () => {
    expect(checkBrowserBudgets({ ...sample, coldStateLoad: NaN, firstGeometry: Infinity, coldRender: 1001, coldReady: 3001 })).toHaveLength(4);
  });
});

describe('project filesystem and preparation performance gate', () => {
  const project = { files: 20, drawings: 21, componentRows: 12000, readBytes: 500000, diskRead: 100, prepare: 1200, reports: 900, total: 2200 };
  it('accepts a complete project and rejects empty, invalid or misreported measurements', () => {
    expect(checkProjectBudgets(project)).toEqual([]);
    expect(checkProjectBudgets({ ...project, files: 0, prepare: NaN, total: 16000 })).toHaveLength(3);
    expect(checkProjectBudgets({ ...project, total: 200 })).toEqual(['project phase timings do not add up to total']);
    for (const factor of [0, -1, Infinity, NaN, 11]) expect(() => checkProjectBudgets(project, factor)).toThrow(/JCAD_PERF_FACTOR/);
  });
});
