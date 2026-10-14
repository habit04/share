import { describe, expect, it } from 'vitest';
import { dashArray, STANDARD_LINETYPES } from '../src/core/linetypes';

/** Canvas alternates positions and repeats an even array; inspect its painted intervals. */
function drawnAt(array: readonly number[], x: number): boolean {
  const period = array.reduce((sum, length) => sum + length, 0);
  let offset = x % period;
  for (let i = 0; i < array.length; i++) { if (offset < array[i]!) return i % 2 === 0; offset -= array[i]!; }
  return false;
}
describe('signed native dash lengths on Canvas', () => {
  it('renders the native GAS and FENCE consecutive spaces as gaps', () => {
    expect(dashArray([12.7, -5.08, -6.35], 1, 10)).toEqual([127, 114.3]);
    expect(dashArray([6.35, -2.54, -2.54, 25.4], 1, 10)).toEqual([63.5, 50.8, 254, 0]);
  });
  it('preserves sign and phase across repeats with leading gaps and terminal dashes', () => {
    const runs = dashArray([-1, 2, -1, 3], 1, 10);
    expect(runs).toEqual([0, 10, 20, 10, 30, 0]);
    expect([5, 15, 35, 45, 65, 75, 85].map((x) => drawnAt(runs, x))).toEqual([false, true, false, true, true, false, true]);
    const terminal = dashArray([1, -2, 3], 1, 10);
    expect(terminal).toEqual([10, 20, 30, 0]);
    expect([5, 15, 35, 65, 75].map((x) => drawnAt(terminal, x))).toEqual([true, false, true, true, false]);
  });
  it('merges adjacent drawn spans and coincident dots without inventing gaps', () => {
    expect(dashArray([2, 3, -1], 1, 10)).toEqual([50, 10]);
    expect(dashArray([0, 0, -2], 1, 10)).toEqual([1, 20]);
    expect(dashArray([0, 2, 0, -1], 1, 10)).toEqual([20, 10]);
    expect(dashArray([1, 2], 1, 10)).toEqual([30, 0]);
    expect(dashArray([-1, -2], 1, 10)).toEqual([0, 30]);
  });
  it('keeps standard patterns, minimum-pixel dots and the existing visibility threshold', () => {
    for (const lt of STANDARD_LINETYPES) expect(dashArray(lt.pattern, 1, 100)).toEqual(lt.pattern.map((length) => length === 0 ? 1 : Math.abs(length) * 100));
    expect(dashArray([0, -1], 1, 10)).toEqual([1, 10]);
    expect(dashArray([1, -1], 1, 1)).toEqual([]);
    expect(dashArray([1, -1], 1, 1, 2)).toEqual([1, 1]);
    expect(dashArray([0.01, -1], 1, 10)).toEqual([1, 10]);
  });
  it('uses both linetype and zoom scales and safely handles nonfinite authored values', () => {
    expect(dashArray([2, -1], 0.5, 10)).toEqual([10, 5]);
    expect(dashArray([2, -1], Infinity, 10)).toEqual([]);
    expect(dashArray([Infinity, -1], 1, 10)).toEqual([]);
  });
});
