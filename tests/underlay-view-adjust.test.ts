// P28 finish slice — section 4.4 visible-region helper tests and section
// 5.4 candidate contrast/mono probes (addendum A.2.2). Tests first.

import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { visibleRegionFor } from '../src/app/underlay-view';
import { adjustUnderlayPixels } from '../src/app/underlay-adjust';

const def = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf',
  extent: { width: 200, height: 100 }, retainedGroups: [], ...over,
});
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});
const view = (min: { x: number; y: number }, max: { x: number; y: number }) => () => ({ min, max });

describe('visibleRegionFor (design 4.4)', () => {
  it('identity placement, full view: the whole page in page coordinates', () => {
    const r = visibleRegionFor({
      viewBounds: view({ x: -10, y: -10 }, { x: 300, y: 200 }),
      pageSizeOf: () => undefined,
    }, def(), [placement()]);
    expect(r).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });

  it('partial view clips the region to the intersection (y-down page space)', () => {
    // World y in [-50, 50] over a 100-tall page at origin: the world's bottom
    // half is the page's BOTTOM half in y-down page coordinates (y 50..100).
    const r = visibleRegionFor({
      viewBounds: view({ x: 0, y: -50 }, { x: 100, y: 50 }),
      pageSizeOf: () => undefined,
    }, def(), [placement()]);
    expect(r).toEqual({ x: 0, y: 50, width: 100, height: 50 });
  });

  it('a placement entirely outside the view yields no region', () => {
    const r = visibleRegionFor({
      viewBounds: view({ x: 1000, y: 1000 }, { x: 2000, y: 2000 }),
      pageSizeOf: () => undefined,
    }, def(), [placement()]);
    expect(r).toBeUndefined();
  });

  it('mirrored placements normalize to the same region', () => {
    const a = visibleRegionFor({
      viewBounds: view({ x: -100, y: -10 }, { x: 100, y: 200 }), pageSizeOf: () => undefined,
    }, def(), [placement({ scaleX: -1 })]);
    const b = visibleRegionFor({
      viewBounds: view({ x: -100, y: -10 }, { x: 100, y: 200 }), pageSizeOf: () => undefined,
    }, def(), [placement()]);
    expect(a).toEqual(b);
  });

  it('the loaded page size wins over the stored extent', () => {
    const r = visibleRegionFor({
      viewBounds: view({ x: -10, y: -10 }, { x: 500, y: 500 }),
      pageSizeOf: () => ({ width: 400, height: 300 }),
    }, def(), [placement()]);
    expect(r).toEqual({ x: 0, y: 0, width: 400, height: 300 });
  });

  it('no extent and no loaded size: no region (service falls back)', () => {
    const r = visibleRegionFor({
      viewBounds: view({ x: 0, y: 0 }, { x: 10, y: 10 }), pageSizeOf: () => undefined,
    }, def({ extent: undefined }), [placement()]);
    expect(r).toBeUndefined();
  });

  it('two placements of one definition union their visible parts', () => {
    // View x 50..250: placement 1 (at origin) shows page x 50..200, placement 2
    // (at x=100) shows page x 0..150; the union is the full page width, which
    // neither placement covers alone.
    const r = visibleRegionFor({
      viewBounds: view({ x: 50, y: 0 }, { x: 250, y: 100 }), pageSizeOf: () => undefined,
    }, def(), [placement(), placement({ id: 'u2', position: { x: 100, y: 0 } })]);
    expect(r).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

describe('adjustUnderlayPixels (candidate equation, A.2 — no AutoCAD parity claim)', () => {
  const px = (arr: number[]) => new Uint8ClampedArray(arr);

  it('c = 0 maps every channel exactly onto the target background; alpha untouched', () => {
    const out = adjustUnderlayPixels(px([10, 200, 90, 77]), 1, 1, { contrast: 0, mono: false, background: [0.5, 0.25, 0] });
    expect([...out]).toEqual([128, 64, 0, 77]);
  });

  it('c = 100 is the identity on pixels and alpha', () => {
    const input = px([0, 127, 255, 42, 33, 34, 35, 255]);
    const out = adjustUnderlayPixels(input, 2, 1, { contrast: 100, mono: false, background: [0.13, 0.57, 0.91] });
    expect([...out]).toEqual([...input]);
  });

  it('c = 50 about black halves every channel', () => {
    const out = adjustUnderlayPixels(px([100, 50, 200, 255]), 1, 1, { contrast: 50, mono: false, background: [0, 0, 0] });
    expect([...out]).toEqual([50, 25, 100, 255]);
  });

  it('mono reduces by Rec.601 luminance BEFORE contrast scaling; alpha preserved', () => {
    // L = .299*100 + .587*150 + .114*200 = 29.9 + 88.05 + 22.8 = 140.75 -> 141 at s=1.
    const flat = adjustUnderlayPixels(px([100, 150, 200, 99]), 1, 1, { contrast: 100, mono: true, background: [0, 0, 0] });
    expect([...flat]).toEqual([141, 141, 141, 99]);
    const half = adjustUnderlayPixels(px([100, 150, 200, 99]), 1, 1, { contrast: 50, mono: true, background: [0, 0, 0] });
    expect([...half]).toEqual([70, 70, 70, 99]); // round(140.75 * 0.5) = 70
  });

  it('clamps at both ends and never mutates the input buffer', () => {
    const input = px([250, 3, 128, 255]);
    const copy = px([...input]);
    const out = adjustUnderlayPixels(input, 1, 1, { contrast: 100, mono: false, background: [1, 1, 1] });
    expect([...out]).toEqual([250, 3, 128, 255]);
    expect([...input]).toEqual([...copy]);
    const hot = adjustUnderlayPixels(px([255, 255, 255, 255]), 1, 1, { contrast: 100, mono: false, background: [0, 0, 0] });
    expect([...hot]).toEqual([255, 255, 255, 255]);
  });

  it('undefined contrast with mono off is a pure copy (identity posture)', () => {
    const input = px([12, 34, 56, 78]);
    const out = adjustUnderlayPixels(input, 1, 1, { contrast: undefined, mono: false, background: [0, 0, 0] });
    expect([...out]).toEqual([...input]);
    expect(out).not.toBe(input);
  });
});
