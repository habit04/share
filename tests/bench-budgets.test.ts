/** Browser performance budgets, ported from PR #2 (codex/electrical-review-fixes 2f89b0e). */
import { describe, expect, it } from 'vitest';
import { checkBrowserBudgets } from '../scripts/bench-budgets.mjs';
const sample = { entities: 50000, selected: 1693, load: 110, renderExtents: 20, renderZoomed: 10, hover: 0.1, windowSelect: 17 };
describe('browser performance gate', () => {
  it('accepts baseline measurements and a bounded shared-runner multiplier', () => {
    expect(checkBrowserBudgets(sample)).toEqual([]);
    expect(checkBrowserBudgets({ ...sample, renderExtents: 75 }, 2)).toEqual([]);
  });
  it('rejects regressions and incomplete benchmark workloads', () => {
    expect(checkBrowserBudgets({ ...sample, entities: 4, selected: 0, hover: 40, load: NaN })).toHaveLength(4);
    for (const factor of [0, -1, Infinity, NaN, 11]) expect(() => checkBrowserBudgets(sample, factor)).toThrow(/JCAD_PERF_FACTOR/);
  });
});
