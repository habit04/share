import { describe, it, expect } from 'vitest';
import { glyphFor, strokeText, strokeTextWidth, hasStrokeFont } from '../src/render/hershey';

describe('Hershey stroke font', () => {
  it('loads the 96 printable ASCII glyphs', () => {
    expect(hasStrokeFont).toBe(true);
    expect(glyphFor('A')).toBeDefined();
    expect(glyphFor('~')).toBeDefined();
    expect(glyphFor(' ')!.strokes).toHaveLength(0);
  });
  it('normalises capitals to a height of 1', () => {
    const H = glyphFor('H')!;
    const ys = H.strokes.flat().map(([, y]) => y);
    expect(Math.max(...ys)).toBeCloseTo(1, 6);
    expect(Math.min(...ys)).toBeCloseTo(0, 6);
    expect(H.advance).toBeGreaterThan(0.5);
  });
  it('places, scales, aligns and rotates strings', () => {
    const w = strokeTextWidth('AB', 2);
    expect(w).toBeGreaterThan(2);
    const left = strokeText('AB', { x: 10, y: 5 }, 2, 0, 'left').flat();
    expect(Math.min(...left.map((p) => p.x))).toBeGreaterThanOrEqual(10 - 1e-9);
    const right = strokeText('AB', { x: 10, y: 5 }, 2, 0, 'right').flat();
    expect(Math.max(...right.map((p) => p.x))).toBeLessThanOrEqual(10 + 1e-9);
    const rot = strokeText('I', { x: 0, y: 0 }, 1, Math.PI / 2, 'left').flat();
    // a rotated 'I' runs along -x (its height maps onto the x axis)
    expect(Math.min(...rot.map((p) => p.x))).toBeLessThan(-0.9);
  });
});
