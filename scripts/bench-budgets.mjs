// Milliseconds on the dense 50,000-entity browser drawing, before the runner multiplier.
// Redraw measurements drop the scene copy; renderCached measures an unchanged cursor frame.
// First-use ceilings additionally cover cold document validation, geometry and painting.
export const BROWSER_BUDGETS = Object.freeze({ coldStateLoad: 2000, firstGeometry: 2000, coldRender: 1000, coldReady: 3000, load: 500, renderExtents: 400, renderZoomed: 100, renderCached: 8, hover: 8, windowSelect: 50 });
export function checkBrowserBudgets(result, factor = 1) {
  if (!Number.isFinite(factor) || factor <= 0 || factor > 10) throw new Error('JCAD_PERF_FACTOR must be greater than zero and at most 10');
  const failures = [];
  if (result.entities !== 50000) failures.push(`expected 50000 entities, got ${result.entities}`);
  if (!(result.selected > 0)) failures.push('window selection did not select any entities');
  for (const [name, limit] of Object.entries(BROWSER_BUDGETS)) {
    const time = result[name];
    if (!Number.isFinite(time) || time < 0 || time > limit * factor) failures.push(`${name}: ${time} ms exceeds ${limit * factor} ms budget`);
  }
  // Reject a benchmark accidentally timing the scene copy instead of drawing the entities.
  if (Number.isFinite(result.renderExtents) && Number.isFinite(result.renderCached) && result.renderExtents < 5 * Math.max(result.renderCached, 0.2)) failures.push(`renderExtents: ${result.renderExtents} ms is not a full redraw (the cursor frame takes ${result.renderCached} ms)`);
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
