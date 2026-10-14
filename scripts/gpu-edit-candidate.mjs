/** Deterministic, readback-free choice of one existing top-level LINE.
 * This ranks geometry, not pixels: the later Canvas freshness check must still
 * reject an occluded edit. The function is self-contained for page injection.
 */
export function chooseBenchmarkLineEdit(state, view, retainedId = null) {
  const project = (p) => {
    const x = p.x - view.center.x, y = p.y - view.center.y;
    const c = Math.cos(view.twist), s = Math.sin(view.twist);
    return { x: view.width / 2 + (x * c - y * s) * view.scale, y: view.height / 2 - (x * s + y * c) * view.scale };
  };
  const inset = 4;
  const inside = (p) => p.x >= inset && p.x <= view.width - inset && p.y >= inset && p.y <= view.height - inset;
  const clippedLength = (a, b) => {
    let lo = 0, hi = 1;
    for (const [p, d, min, max] of [[a.x, b.x - a.x, inset, view.width - inset], [a.y, b.y - a.y, inset, view.height - inset]]) {
      if (d === 0) { if (p < min || p > max) return 0; continue; }
      const u = (min - p) / d, v = (max - p) / d;
      lo = Math.max(lo, Math.min(u, v)); hi = Math.min(hi, Math.max(u, v));
    }
    return Math.max(0, hi - lo) * Math.hypot(b.x - a.x, b.y - a.y);
  };
  let best = null;
  for (let sourceIndex = 0; sourceIndex < state.entities.length; sourceIndex++) {
    const original = state.entities[sourceIndex];
    if (original.type !== 'line' || (retainedId !== null && original.id !== retainedId)) continue;
    if (state.layers.some((layer) => layer.name === original.layer && !layer.visible)) continue;
    const dx = original.b.x - original.a.x, dy = original.b.y - original.a.y, worldLength = Math.hypot(dx, dy);
    if (!(worldLength > 0 && Number.isFinite(worldLength) && view.scale > 0)) continue;
    const worldVector = { x: -dy / worldLength * 2 / view.scale, y: dx / worldLength * 2 / view.scale };
    const edited = { ...original, a: { x: original.a.x + worldVector.x, y: original.a.y + worldVector.y }, b: { x: original.b.x + worldVector.x, y: original.b.y + worldVector.y } };
    const a = project(original.a), b = project(original.b), ea = project(edited.a), eb = project(edited.b);
    if (![a, b, ea, eb].every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    const visibleLengthCss = Math.min(clippedLength(a, b), clippedLength(ea, eb));
    const screenLength = Math.hypot(b.x - a.x, b.y - a.y), sx = ea.x - a.x, sy = ea.y - a.y;
    const displacementCss = Math.min(Math.hypot(sx, sy), Math.hypot(eb.x - b.x, eb.y - b.y));
    const perpendicularDisplacementCss = Math.abs((b.x - a.x) * sy - (b.y - a.y) * sx) / screenLength;
    if (!(visibleLengthCss > 0 && displacementCss >= 1 && perpendicularDisplacementCss >= 1)) continue;
    const fullyInset = [a, b, ea, eb].every(inside), score = visibleLengthCss * perpendicularDisplacementCss;
    const candidate = { original, edited, sourceIndex, worldVector, displacementCss, perpendicularDisplacementCss, visibleLengthCss, fullyInset, score, selectionStrategy: 'Frozen existing LINE ID; prefer fully inset, maximum projected swept area under a perpendicular two-CSS-pixel translation; no readback or renderer output used' };
    if (!best || Number(fullyInset) > Number(best.fullyInset) || (fullyInset === best.fullyInset && (score > best.score || (score === best.score && sourceIndex > best.sourceIndex)))) best = candidate;
  }
  if (!best) throw new Error(retainedId === null ? 'Edit benchmark needs a representable visible existing LINE' : `Frozen edit LINE ${retainedId} is not visibly/representably editable at this retained camera`);
  return best;
}
