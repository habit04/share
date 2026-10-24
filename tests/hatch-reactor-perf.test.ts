/**
 * v0.6.4 pre-release review finding F-C: ensureAssociativeHatchReactors
 * applied its edits with one whole-array `lines.splice` per operation,
 * O(edits × lines) — 8000 associative hatches wrote in ~1080 ms against
 * ~114 ms on v0.6.3. The pass now rebuilds the array in one linear sweep.
 *
 * The regression guard bounds GROWTH, not absolute time: the pass runs on
 * N and 4N hatches (each needing one reactor insertion) and the 4N time
 * must stay under 8× the N time (linear ≈ 4×, the quadratic loop ≈ 16×).
 * A floor on the N time keeps machine noise from producing a false ratio.
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
  it('completes every boundary and the 4N run stays under 8× the N run', () => {
    const n = 2000;
    const small = text(n);
    const large = text(4 * n);
    // Correctness on the small input: every polyline gains exactly its hatch.
    const done = ensureAssociativeHatchReactors(small);
    expect((done.match(/\{ACAD_REACTORS/g) ?? []).length).toBe(n);
    expect(ensureAssociativeHatchReactors(done)).toBe(done);
    // Warm-up, then best-of runs.
    ensureAssociativeHatchReactors(large);
    const tSmall = Math.max(best(() => ensureAssociativeHatchReactors(small), 3), 10);
    const tLarge = best(() => ensureAssociativeHatchReactors(large), 3);
    expect(tLarge, `N=${n}: ${tSmall.toFixed(1)} ms, 4N: ${tLarge.toFixed(1)} ms`).toBeLessThan(8 * tSmall);
  }, 120_000);
});
