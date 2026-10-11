/** Browser performance budgets, ported from PR #2 (codex/electrical-review-fixes 2f89b0e). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBrowserBudgets } from '../scripts/bench-budgets.mjs';
// Measured on the development container (scripts/bench.mjs, Chromium headless, software raster).
const sample = { entities: 50000, selected: 1693, load: 40, renderExtents: 172, renderZoomed: 31, renderCached: 0.4, hover: 0.1, windowSelect: 13 };
describe('browser performance gate', () => {
  it('accepts baseline measurements and a bounded shared-runner multiplier', () => {
    expect(checkBrowserBudgets(sample)).toEqual([]);
    expect(checkBrowserBudgets({ ...sample, renderExtents: 700, renderZoomed: 150 }, 2)).toEqual([]);
  });
  it('rejects regressions and incomplete benchmark workloads', () => {
    expect(checkBrowserBudgets({ ...sample, entities: 4, selected: 0, hover: 40, load: NaN })).toHaveLength(4);
    expect(checkBrowserBudgets({ ...sample, renderExtents: 900 }, 2)).toEqual(['renderExtents: 900 ms exceeds 800 ms budget']);
    expect(checkBrowserBudgets({ ...sample, renderCached: 30 }, 2)).toEqual(['renderCached: 30 ms exceeds 16 ms budget']);
    for (const factor of [0, -1, Infinity, NaN, 11]) expect(() => checkBrowserBudgets(sample, factor)).toThrow(/JCAD_PERF_FACTOR/);
  });
  it('a "redraw" that took no longer than the scene copy is refused: the benchmark measured the cache', () => {
    // What the budgets timed after the scene cache came in: the same frame again, 0.5 ms.
    expect(checkBrowserBudgets({ ...sample, renderExtents: 0.5, renderCached: 0.4 })).toEqual(['renderExtents: 0.5 ms is not a full redraw (the cursor frame takes 0.4 ms)']);
  });
  it('scripts/bench.mjs drops the scene copy before each timed redraw', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'scripts', 'bench.mjs'), 'utf8');
    expect(src).toMatch(/const redraw = \(\) => \{\s*vp\.baseScene = null;\s*ed\.viewport\.render\(ov\);/);
    expect(src).toMatch(/out\.renderExtents = await best\(redraw, 5\);/);
    expect(src).toMatch(/out\.renderZoomed = await best\(redraw, 5\);/);
    expect(readFileSync(join(import.meta.dirname, '..', 'src', 'render', 'viewport.ts'), 'utf8')).toMatch(/private baseScene: /);
  });
});
