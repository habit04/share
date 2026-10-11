// Milliseconds on the dense 50,000-entity browser drawing, before the runner multiplier.
// First-use ceilings allow slower shared runners and do not replace the existing warm limits.
export const BROWSER_BUDGETS = Object.freeze({ coldStateLoad: 2000, firstGeometry: 2000, coldRender: 1000, coldReady: 3000, load: 500, renderExtents: 50, renderZoomed: 25, hover: 8, windowSelect: 50 });
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

export function checkProjectBudgets(result, factor = 1) {
  if (!Number.isFinite(factor) || factor <= 0 || factor > 10) throw new Error('JCAD_PERF_FACTOR must be greater than zero and at most 10');
  const failures = [];
  if (result.files !== 20 || result.drawings !== 21 || result.componentRows !== 12000 || !(result.readBytes > 0)) failures.push('incomplete 20-file/12000-component project workload');
  for (const name of ['diskRead', 'prepare', 'reports', 'total']) {
    if (!Number.isFinite(result[name]) || result[name] < 0) failures.push(`invalid project ${name}: ${result[name]}`);
  }
  if (Number.isFinite(result.total) && result.total > 15000 * factor) failures.push(`project total: ${result.total} ms exceeds ${15000 * factor} ms budget`);
  if (Number.isFinite(result.total) && Math.abs(result.total - result.diskRead - result.prepare - result.reports) > 1) failures.push('project phase timings do not add up to total');
  return failures;
}
