// Milliseconds on the dense 50,000-entity browser drawing, before the runner multiplier.
export const BROWSER_BUDGETS = Object.freeze({ load: 500, renderExtents: 50, renderZoomed: 25, hover: 8, windowSelect: 50 });
export function checkBrowserBudgets(result, factor = 1) {
  if (!Number.isFinite(factor) || factor <= 0 || factor > 10) throw new Error('JCAD_PERF_FACTOR must be greater than zero and at most 10');
  const failures = [];
  if (result.entities !== 50000) failures.push(`expected 50000 entities, got ${result.entities}`);
  if (!(result.selected > 0)) failures.push('window selection did not select any entities');
  for (const [name, limit] of Object.entries(BROWSER_BUDGETS)) {
    const time = result[name];
    if (!Number.isFinite(time) || time < 0 || time > limit * factor) failures.push(`${name}: ${time} ms exceeds ${limit * factor} ms budget`);
  }
  return failures;
}
