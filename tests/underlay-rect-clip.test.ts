/** D2 pins — an AutoCAD 2-point rectangle clip hides all content (real-app
 * gate on #57, lead finding D2).
 *
 * The model documents the stored form: '2 points = rectangle, 3+ =
 * polygon' (src/core/underlay.ts, the clipBoundary field). But no code
 * expands the 2-point form: underlayDisplayList emits the clip-frame
 * op with the two stored points as-is, so every consumer builds a
 * 2-vertex polygon — the canvas clip is a degenerate sliver that clips
 * the raster to nothing, the vector clip hides the plotted content,
 * and the outline draws the diagonal between the two corners. The
 * lead's repro: the golden r2018-pdf-underlay-dict-acad2027.dxf (whose
 * PDFUNDERLAY carries exactly this 2-point clip) shows an empty frame
 * with real.pdf; the same clip written as 4 points renders.
 *
 * The fix point is the display list itself — the one producer every
 * geometry consumer eats — so these pins assert at the op level and
 * at the canvas consumer. The writer-level and golden end-to-end pins
 * live in tests/pdf-vector-underlay.test.ts. The DXF codec is NOT a
 * consumer: stored points round-trip verbatim (existing codec pins).
 */
import { describe, it, expect } from 'vitest';
import {
  underlayDisplayList,
  type UnderlayDefinition,
  type UnderlayPlacement,
} from '../src/core/underlay';
import type { UnderlayEntity } from '../src/core/entities';
import { drawEntity } from '../src/render/draw';

const pdfDef: UnderlayDefinition = {
  id: 'def-1', handle: '2E', kind: 'pdf', sourcePath: 'refs\\floor.pdf', page: '1',
  extent: { width: 200, height: 100 }, retainedGroups: [],
};
const base: UnderlayPlacement = {
  id: 'u1', handle: '2F', kind: 'pdf', definitionHandle: '2E', layer: 'PDF',
  position: { x: 10, y: 20 }, scaleX: 2, scaleY: 2, rotation: 0,
  flags: 2 | 1, // ON + CLIPPING_ON
  retainedGroups: [],
};

const clipPoints = (p: UnderlayPlacement) => {
  const op = underlayDisplayList(p, pdfDef, { width: 200, height: 100 }).find((o) => o.op === 'clip-frame');
  return op && op.op === 'clip-frame' ? op.points : undefined;
};

describe('D2: the display list expands a 2-point clip to the axis-aligned rectangle', () => {
  it('two diagonal corners (max-y/min-y order, as AutoCAD stores them) become the 4 rectangle corners in world space', () => {
    // Underlay-coords corners (0,50) and (100,0): the rectangle is
    // (0,0)-(100,50); world = position (10,20), scale 2.
    const pts = clipPoints({ ...base, clipBoundary: [{ x: 0, y: 50 }, { x: 100, y: 0 }] });
    expect(pts).toEqual([
      { x: 10, y: 20 }, { x: 210, y: 20 }, { x: 210, y: 120 }, { x: 10, y: 120 },
    ]);
  });

  it('the corner order stored does not matter: min/min-first gives the same op', () => {
    const a = clipPoints({ ...base, clipBoundary: [{ x: 0, y: 50 }, { x: 100, y: 0 }] });
    const b = clipPoints({ ...base, clipBoundary: [{ x: 100, y: 0 }, { x: 0, y: 50 }] });
    const c = clipPoints({ ...base, clipBoundary: [{ x: 0, y: 0 }, { x: 100, y: 50 }] });
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it('a 3+ point polygon boundary passes through point-for-point (unchanged)', () => {
    const pts = clipPoints({ ...base, clipBoundary: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }] });
    expect(pts).toEqual([{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 120 }]);
  });

  it('the stored boundary is not mutated by the expansion', () => {
    const boundary = [{ x: 0, y: 50 }, { x: 100, y: 0 }];
    clipPoints({ ...base, clipBoundary: boundary });
    expect(boundary).toEqual([{ x: 0, y: 50 }, { x: 100, y: 0 }]);
  });
});

// ---- the canvas consumer (tests/underlay-draw-clip.test.ts idiom) ----

const defE = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf',
  extent: { width: 200, height: 100 }, retainedGroups: [], ...over,
});
const placementE = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

/** Recording ctx that keeps moveTo/lineTo arguments (the clip path shape). */
function recordingCtx() {
  const log: string[] = [];
  const base: Record<string, unknown> = { globalAlpha: 1 };
  const ctx = new Proxy(base, {
    get: (t, p) => (p in t ? t[p as string] : (...args: unknown[]) => {
      log.push(p === 'moveTo' || p === 'lineTo' ? `${String(p)}(${args.join(',')})` : String(p));
    }),
    set: (t, p, v) => { t[p as string] = v; return true; },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, log };
}
const tf = { scale: 1, toScreen: (p: { x: number; y: number }) => p } as unknown as Parameters<typeof drawEntity>[2];
const layers = [{ name: 'U', visible: true, frozen: false, color: 7, linetype: 'Continuous', lineWeight: -3, plottable: true }] as unknown as Parameters<typeof drawEntity>[3];
const lookup = (() => undefined) as unknown as Parameters<typeof drawEntity>[4];
const rasterSource = () => ({ definition: defE(), page: { width: 200, height: 100 }, image: { bitmap: {} as CanvasImageSource, width: 200, height: 100 } });

describe('D2: the canvas consumer clips the raster to the rectangle, not the diagonal sliver', () => {
  it('a 2-point clip traces the 4 rectangle corners before clip()', () => {
    const { ctx, log } = recordingCtx();
    const clipped = placementE({ flags: 3, clipBoundary: [{ x: 10, y: 90 }, { x: 190, y: 10 }] });
    drawEntity(ctx, clipped, tf, layers, lookup, { underlaySource: rasterSource });
    const clipAt = log.indexOf('clip');
    expect(clipAt).toBeGreaterThan(-1);
    const path = log.slice(0, clipAt).filter((l) => l.startsWith('moveTo') || l.startsWith('lineTo') || l === 'closePath');
    expect(path).toEqual(['moveTo(10,10)', 'lineTo(190,10)', 'lineTo(190,90)', 'lineTo(10,90)', 'closePath']);
    expect(log.indexOf('drawImage')).toBeGreaterThan(clipAt);
  });
});
