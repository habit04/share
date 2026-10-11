// Milliseconds on the dense 50,000-entity browser drawing, before the runner multiplier
// (JCAD_PERF_FACTOR, 2 in CI). renderExtents / renderZoomed time a full redraw (the scene copy
// dropped first: 160 - 230 ms and 26 - 40 ms on the development container, so about twice that),
// renderCached the frame a cursor move draws on an unchanged view (the scene copy, within a frame).
export const BROWSER_BUDGETS = Object.freeze({ load: 500, renderExtents: 400, renderZoomed: 100, renderCached: 8, hover: 8, windowSelect: 50 });
export function checkBrowserBudgets(result, factor = 1) {
  if (!Number.isFinite(factor) || factor <= 0 || factor > 10) throw new Error('JCAD_PERF_FACTOR must be greater than zero and at most 10');
  const failures = [];
  if (result.entities !== 50000) failures.push(`expected 50000 entities, got ${result.entities}`);
  if (!(result.selected > 0)) failures.push('window selection did not select any entities');
  for (const [name, limit] of Object.entries(BROWSER_BUDGETS)) {
    const time = result[name];
    if (!Number.isFinite(time) || time < 0 || time > limit * factor) failures.push(`${name}: ${time} ms exceeds ${limit * factor} ms budget`);
  }
  // A "redraw" as fast as the scene copy did not draw the entities: the benchmark measures the cache.
  if (Number.isFinite(result.renderExtents) && Number.isFinite(result.renderCached) && result.renderExtents < 5 * Math.max(result.renderCached, 0.2)) failures.push(`renderExtents: ${result.renderExtents} ms is not a full redraw (the cursor frame takes ${result.renderCached} ms)`);
  return failures;
}
