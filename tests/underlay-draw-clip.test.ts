// P28 finish — section 5.1/5.2 pins on the canvas consumer: fade applies
// multiplicatively at draw time (never baked into the raster), and the
// clip-frame op clips ONLY the raster draw. Recording-ctx idiom from
// tests/underlay-engine.test.ts.

import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { drawEntity } from '../src/render/draw';

const def = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf',
  extent: { width: 200, height: 100 }, retainedGroups: [], ...over,
});
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

function recordingCtx() {
  const log: string[] = [];
  const base: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(base, {
    get: (t, p) => (p in t ? t[p as string] : (...args: unknown[]) => { log.push(String(p)); void args; }),
    set: (t, p, v) => { t[p as string] = v; log.push(`set:${String(p)}=${String(v)}`); return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}
const tf = { scale: 1, toScreen: (p: { x: number; y: number }) => p } as unknown as Parameters<typeof drawEntity>[2];
const layers = [{ name: 'U', visible: true, frozen: false, color: 7, linetype: 'Continuous', lineWeight: -3, plottable: true }] as unknown as Parameters<typeof drawEntity>[3];
const lookup = (() => undefined) as unknown as Parameters<typeof drawEntity>[4];
const rasterSource = () => ({ definition: def(), page: { width: 200, height: 100 }, image: { bitmap: {} as CanvasImageSource, width: 200, height: 100 } });

describe('underlay fade + clip at the canvas consumer (design 5.1/5.2)', () => {
  it('fade 40 multiplies globalAlpha by 0.6 for the image draw, and only there', () => {
    const { ctx, log } = recordingCtx();
    drawEntity(ctx, placement({ fade: 40 }), tf, layers, lookup, { underlaySource: rasterSource });
    const drawAt = log.indexOf('drawImage');
    expect(drawAt).toBeGreaterThan(-1);
    const alphaSets = log.slice(0, drawAt).filter((l) => l.startsWith('set:globalAlpha'));
    expect(alphaSets[alphaSets.length - 1]).toBe('set:globalAlpha=0.6');
  });

  it('no fade: globalAlpha is never scaled for the image draw', () => {
    const { ctx, log } = recordingCtx();
    drawEntity(ctx, placement(), tf, layers, lookup, { underlaySource: rasterSource });
    const drawAt = log.indexOf('drawImage');
    expect(drawAt).toBeGreaterThan(-1);
    // The entity-alpha baseline may set globalAlpha = 1 (draw.ts entity
    // alpha); a fade would multiply it below 1 before the draw.
    const scaled = log.slice(0, drawAt).filter((l) => l.startsWith('set:globalAlpha') && l !== 'set:globalAlpha=1');
    expect(scaled).toEqual([]);
  });

  it('a clip boundary clips the raster draw (clip before drawImage, exactly once)', () => {
    const { ctx, log } = recordingCtx();
    const clipped = placement({
      flags: 3, // ON + CLIPPING_ON
      clipBoundary: [{ x: 10, y: 10 }, { x: 190, y: 10 }, { x: 190, y: 90 }, { x: 10, y: 90 }],
    });
    drawEntity(ctx, clipped, tf, layers, lookup, { underlaySource: rasterSource });
    const clips = log.filter((l) => l === 'clip');
    expect(clips).toHaveLength(1);
    expect(log.indexOf('clip')).toBeLessThan(log.indexOf('drawImage'));
    expect(log).toContain('stroke'); // the frame still draws, outside the clip
  });

  it('without a clip boundary no clip is applied to the raster', () => {
    const { ctx, log } = recordingCtx();
    drawEntity(ctx, placement(), tf, layers, lookup, { underlaySource: rasterSource });
    expect(log).toContain('drawImage');
    expect(log.filter((l) => l === 'clip')).toEqual([]);
  });
});
