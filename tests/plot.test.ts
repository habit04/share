import { describe, it, expect } from 'vitest';
import { layoutPage, paperById, PAPER_SIZES } from '../src/app/plot';

describe('plot page layout', () => {
  it('fits a landscape ladder onto 11 x 17 in landscape, centred inside the margins', () => {
    const lay = layoutPage(20, 12, { paper: 'tabloid', orientation: 'auto', scale: 'fit', margin: 0.5 });
    expect(lay.sheet).toEqual({ width: 17, height: 11 });
    expect(lay.landscape).toBe(true);
    expect(lay.electron).toBe('Tabloid');
    // 16 x 10 in available; 20 x 12 units -> scale limited by width: 0.8
    expect(lay.scale).toBeCloseTo(0.8);
    expect(lay.origin.x).toBeCloseTo(0.5);
    expect(lay.origin.y).toBeCloseTo(0.5 + (10 - 9.6) / 2);
    expect(lay.reducedToFit).toBe(false);
  });
  it('honours a forced portrait orientation and a 1:1 scale that fits', () => {
    const lay = layoutPage(6, 8, { paper: 'letter', orientation: 'portrait', scale: '1:1', margin: 0.25 });
    expect(lay.sheet).toEqual({ width: 8.5, height: 11 });
    expect(lay.scale).toBe(1);
    expect(lay.origin.x).toBeCloseTo(0.25 + (8 - 6) / 2);
    expect(lay.reducedToFit).toBe(false);
  });
  it('reduces a fixed scale that would overflow the paper and says so', () => {
    const lay = layoutPage(30, 20, { paper: 'letter', orientation: 'auto', scale: '1:1', margin: 0.25 });
    expect(lay.scale).toBeLessThan(1);
    expect(lay.reducedToFit).toBe(true);
  });
  it('makes a custom sheet from the drawing size when fitting to the drawing', () => {
    const lay = layoutPage(30, 20, { paper: 'fit', orientation: 'auto', scale: '1:2', margin: 0.25 });
    expect(lay.sheet.width).toBeCloseTo(15.5);
    expect(lay.sheet.height).toBeCloseTo(10.5);
    expect(lay.electron).toBeUndefined();
  });
  it('knows the common paper sizes', () => {
    expect(paperById('tabloid').width).toBe(11);
    expect(paperById('tabloid').height).toBe(17);
    expect(paperById('ansi-d')).toMatchObject({ width: 22, height: 34 });
    expect(paperById('nope').id).toBe('fit');
    expect(PAPER_SIZES.map((p) => p.id)).toContain('a3');
  });
});
