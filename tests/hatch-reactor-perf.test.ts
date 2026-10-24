/**
 * v0.6.4 pre-release review finding F-C: ensureAssociativeHatchReactors
 * applied its edits with one whole-array `lines.splice` per operation,
 * O(edits × lines) — 8000 associative hatches wrote in ~1080 ms against
 * ~114 ms on v0.6.3. The pass now rebuilds the array in one linear sweep.
 *
 * The regression guard bounds GROWTH, not absolute time: the pass runs on
 * N and 8N hatches (each needing one reactor insertion) and the 8N time
 * must stay under 20× the N time (linear ≈ 8×; the quadratic loop ≈ 64×,
 * measured 19× already at 4N on 3e66ef6). The wide gap between the linear
 * and quadratic outcomes, a 25 ms floor on the N time and best-of-five
 * sampling keep a CI runner's GC pause or scheduler hiccup from flipping
 * the verdict either way (re-review follow-up (3)).
 */
import { describe, it, expect } from 'vitest';
import { ensureAssociativeHatchReactors } from '../src/io/cad-graph-dxf';

/** N closed LWPOLYLINEs (no reactors yet) + N associative SOLID hatches naming them. */
function text(n: number): string {
  const out: string[] = ['0', 'SECTION', '2', 'HEADER', '9', '$ACADVER', '1', 'AC1015', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  for (let i = 0; i < n; i++) {
    const poly = (0x1000 + 2 * i).toString(16).toUpperCase();
    const hatch = (0x1001 + 2 * i).toString(16).toUpperCase();
    const x = (i % 100) * 2, y = Math.floor(i / 100) * 2;
    out.push('0', 'LWPOLYLINE', '5', poly, '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbPolyline', '90', '4', '70', '1',
      '10', String(x), '20', String(y), '10', String(x + 1), '20', String(y), '10', String(x + 1), '20', String(y + 1), '10', String(x), '20', String(y + 1));
    out.push('0', 'HATCH', '5', hatch, '330', '1F', '100', 'AcDbEntity', '8', '0', '100', 'AcDbHatch',
      '10', '0', '20', '0', '30', '0', '210', '0', '220', '0', '230', '1', '2', 'SOLID', '70', '1', '71', '1', '91', '1',
      '92', '3', '72', '0', '73', '1', '93', '4',
      '10', String(x), '20', String(y), '10', String(x + 1), '20', String(y), '10', String(x + 1), '20', String(y + 1), '10', String(x), '20', String(y + 1),
      '97', '1', '330', poly, '75', '0', '76', '1', '98', '0');
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return out.join('\r\n');
}

const best = (fn: () => unknown, runs: number): number => {
  let b = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    fn();
    b = Math.min(b, performance.now() - t);
  }
  return b;
};

describe('F-C: reactor completion scales linearly in the hatch count', () => {
  it('completes every boundary and the 8N run stays under 20× the N run', () => {
    const n = 1500;
    const small = text(n);
    const large = text(8 * n);
    // Correctness on both inputs: every polyline gains exactly its hatch, and a
    // complete text is returned untouched.
    const done = ensureAssociativeHatchReactors(small);
    expect((done.match(/\{ACAD_REACTORS/g) ?? []).length).toBe(n);
    expect(ensureAssociativeHatchReactors(done)).toBe(done);
    const doneLarge = ensureAssociativeHatchReactors(large);
    expect((doneLarge.match(/\{ACAD_REACTORS/g) ?? []).length).toBe(8 * n);
    // Best-of runs (the calls above were the warm-up).
    const tSmall = Math.max(best(() => ensureAssociativeHatchReactors(small), 5), 25);
    const tLarge = best(() => ensureAssociativeHatchReactors(large), 3);
    expect(tLarge, `N=${n}: ${tSmall.toFixed(1)} ms, 8N: ${tLarge.toFixed(1)} ms`).toBeLessThan(20 * tSmall);
  }, 180_000);
});
