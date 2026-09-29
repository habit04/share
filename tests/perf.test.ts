import { describe, it, expect } from 'vitest';
import { Drawing } from '../src/core/document';
import { selectByBox, pickEntity } from '../src/core/selection';
import { findObjectSnap, defaultSnapSettings } from '../src/core/snap';
import { readDxf, writeDxf } from '../src/io/dxf';
import { bigDrawing } from './helpers/big-drawing';

// Performance budgets on a large schematic (5,000 lines + 1,000 symbol inserts + 500 texts).
// Budgets are about 3x what these operations took on the development container (timings are
// printed on every run) with a floor, so slower CI runners do not flake while an accidental
// O(n^2) regression (10-100x) still fails. JCAD_PERF_FACTOR scales every budget (e.g. 2 on a
// very slow runner).

const FACTOR = Number(process.env.JCAD_PERF_FACTOR ?? '1') || 1;
/**
 * Budgets in ms: the slowest measurement on the development container (best-of-N each, alone and
 * with the whole suite running in parallel), times 3, with a 50 ms floor. Measured: extents 12,
 * window 2, crossing 2.3, pick 3.8, snap 2.7, writeDxf 86, readDxf 121 ms.
 */
const BUDGET = {
  extents: 50,
  windowSelect: 50,
  crossingSelect: 50,
  pick: 50,
  snap: 50,
  writeDxf: 300,
  readDxf: 400,
};

function time<T>(label: string, fn: () => T, runs = 3): { ms: number; value: T } {
  // Best of a few runs: the first run also pays for JIT warm-up.
  let best = Infinity;
  let value: T | undefined;
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - t0);
  }
  console.log(`perf ${label.padEnd(16)} ${best.toFixed(1).padStart(8)} ms`);
  return { ms: best, value: value as T };
}

describe('performance on a 6,500-entity drawing', () => {
  const state = bigDrawing(5000, 1000, 500);
  const doc = new Drawing(state);
  const lookup = doc.lookupBlock;
  const none = new Set<string>();

  it('has the expected size', () => {
    expect(doc.entities.length).toBe(6500);
  });

  it('extents()', () => {
    const { ms, value } = time('extents', () => doc.extents());
    expect(value).not.toBeNull();
    expect(value!.min.x).toBeGreaterThanOrEqual(-1);
    expect(value!.max.x).toBeLessThanOrEqual(210);
    expect(ms).toBeLessThan(BUDGET.extents * FACTOR);
  });

  it('window and crossing selection queries', () => {
    const box = { min: { x: 50, y: 40 }, max: { x: 120, y: 90 } };
    const w = time('window select', () => selectByBox(box, 'window', doc.entities, lookup, none));
    expect(w.value.length).toBeGreaterThan(100);
    expect(w.ms).toBeLessThan(BUDGET.windowSelect * FACTOR);
    const c = time('crossing select', () => selectByBox(box, 'crossing', doc.entities, lookup, none));
    expect(c.value.length).toBeGreaterThanOrEqual(w.value.length);
    expect(c.ms).toBeLessThan(BUDGET.crossingSelect * FACTOR);
  });

  it('pick and object-snap candidate search near a point', () => {
    const target = doc.entities[1234]!;
    if (target.type !== 'line') throw new Error('fixture: expected a line');
    const p = time('pick', () => pickEntity(target.a, doc.entities, lookup, 0.05, none));
    expect(p.value).not.toBeNull();
    expect(p.ms).toBeLessThan(BUDGET.pick * FACTOR);
    const settings = defaultSnapSettings();
    const s = time('snap', () => findObjectSnap({ x: target.a.x + 0.01, y: target.a.y + 0.01 }, doc.entities, lookup, settings, 0.1, null, none));
    expect(s.value).not.toBeNull();
    expect(s.ms).toBeLessThan(BUDGET.snap * FACTOR);
  });

  it('writeDxf / readDxf', () => {
    const w = time('writeDxf', () => writeDxf(state), 2);
    expect(w.value.length).toBeGreaterThan(100_000);
    expect(w.ms).toBeLessThan(BUDGET.writeDxf * FACTOR);
    const r = time('readDxf', () => readDxf(w.value), 2);
    expect(r.value.entities.length).toBe(6500);
    expect(r.ms).toBeLessThan(BUDGET.readDxf * FACTOR);
  });
});
