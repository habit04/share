import { describe, it, expect } from 'vitest';
import type { UnderlayEntity } from '../src/core/entities';
import type { UnderlayDefinition } from '../src/core/underlay';
import { underlayRefusal, type UnderlayRasterEngine } from '../src/io/underlay-engine';
import { createUnderlayDisplayService, underlayPageIndex } from '../src/app/underlay-render';
import { drawEntity } from '../src/render/draw';
import { underlayDefinitionContent } from '../src/render/underlay-content';
import { normalizeEntity } from '../src/app/api';
import { Drawing } from '../src/core/document';

// P28 wiring: interface consumers against a FAKE engine — this file must
// never import pdfjs (the seam's whole point). The display service and the
// draw path run entirely on the interface + the fake.

const tick = async (): Promise<void> => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

const def = (over: Partial<UnderlayDefinition> = {}): UnderlayDefinition => ({
  id: 'underlaydef:41', handle: '41', kind: 'pdf', sourcePath: 'plans\\floor.pdf', retainedGroups: [], ...over,
});
const placement = (over: Partial<UnderlayEntity> = {}): UnderlayEntity => ({
  id: 'u1', layer: 'U', color: 'ByLayer', type: 'underlay', kind: 'pdf', definitionHandle: '41',
  position: { x: 0, y: 0 }, scaleX: 1, scaleY: 1, rotation: 0, flags: 2, retainedGroups: [], ...over,
});

function fakeEngine(opts: { pages?: number; fail?: boolean } = {}): UnderlayRasterEngine & { opens: number } {
  const state = { opens: 0 };
  return {
    kind: 'pdf',
    get opens() { return state.opens; },
    async open() {
      state.opens += 1;
      if (opts.fail) return underlayRefusal('corrupt', 'fake refusal');
      const pageCount = opts.pages ?? 3;
      return {
        ok: true as const,
        value: {
          pageCount,
          async pageSize(page: number) {
            return page >= 1 && page <= pageCount
              ? { ok: true as const, value: { width: 200, height: 100 } }
              : underlayRefusal('corrupt', 'out of range');
          },
          async renderPage(page: number, scale: number) {
            const sized = await this.pageSize(page);
            if (!sized.ok) return sized;
            return { ok: true as const, value: { image: { fakeBitmap: true }, width: Math.round(200 * scale), height: Math.round(100 * scale), pageSize: sized.value } };
          },
          async renderRegion(page: number, region: { x: number; y: number; width: number; height: number }, scale: number) {
            const sized = await this.pageSize(page);
            if (!sized.ok) return sized;
            return { ok: true as const, value: { image: { fakeBitmap: true, region }, width: Math.round(region.width * scale), height: Math.round(region.height * scale), pageSize: sized.value, region } };
          },
          close() { /* no-op */ },
        },
      };
    },
  };
}

describe('underlay display service (fake engine)', () => {
  it('a dangling placement resolves to nothing (frame + cross, no label)', () => {
    const svc = createUnderlayDisplayService({ engine: fakeEngine(), bytesFor: async () => new Uint8Array(1), definitions: () => ({}) });
    expect(svc.source(placement())).toBeUndefined();
  });

  it('frame + label while loading; bitmap + true extent once the raster lands', async () => {
    const engine = fakeEngine();
    let redraws = 0;
    const svc = createUnderlayDisplayService({
      engine,
      bytesFor: async () => new Uint8Array([1, 2, 3]),
      definitions: () => ({ 'underlaydef:41': def() }),
      requestRedraw: () => { redraws += 1; },
    });
    const first = svc.source(placement());
    expect(first?.definition.sourcePath).toBe('plans\\floor.pdf');
    expect(first?.image).toBeUndefined();
    await tick();
    const ready = svc.source(placement());
    expect(ready?.image).toBeDefined();
    expect(ready?.page).toEqual({ width: 200, height: 100 });
    expect(ready?.definition.extent).toEqual({ width: 200, height: 100 }); // extent-filled VIEW
    expect(def().extent).toBeUndefined(); // the stored definition is never mutated
    expect(engine.opens).toBe(1); // cached: repeated sources do not re-open
    expect(svc.source(placement())?.image).toBeDefined();
    expect(engine.opens).toBe(1);
    expect(redraws).toBe(1);
  });

  it('no bytes / engine refusal settle as frame + label, never a throw', async () => {
    const noBytes = createUnderlayDisplayService({ engine: fakeEngine(), bytesFor: async () => null, definitions: () => ({ 'underlaydef:41': def() }) });
    noBytes.source(placement());
    await tick();
    expect(noBytes.source(placement())?.image).toBeUndefined();
    expect(noBytes.source(placement())?.definition.sourcePath).toBe('plans\\floor.pdf');
    const refusing = createUnderlayDisplayService({ engine: fakeEngine({ fail: true }), bytesFor: async () => new Uint8Array(1), definitions: () => ({ 'underlaydef:41': def() }) });
    refusing.source(placement());
    await tick();
    expect(refusing.source(placement())?.image).toBeUndefined();
  });

  it('DWF/DGN resolve for frame + label and are never opened (no admitted decoder)', async () => {
    const engine = fakeEngine();
    const svc = createUnderlayDisplayService({ engine, bytesFor: async () => new Uint8Array(1), definitions: () => ({ 'underlaydef:41': def({ kind: 'dwf' }) }) });
    const out = svc.source(placement({ kind: 'dwf' }));
    expect(out?.definition.kind).toBe('dwf');
    await tick();
    expect(engine.opens).toBe(0);
  });

  it('page index: numeric names only, everything else is page 1', () => {
    expect(underlayPageIndex(def())).toBe(1);
    expect(underlayPageIndex(def({ page: 'Sheet1' }))).toBe(1);
    expect(underlayPageIndex(def({ page: '2' }))).toBe(2);
  });
});

describe('draw path consumes the display list', () => {
  const recordingCtx = () => {
    const calls: string[] = [];
    const base: Record<string, unknown> = { globalAlpha: 1 };
    const ctx = new Proxy(base, {
      get: (t, p) => (p in t ? t[p as string] : (...args: unknown[]) => { calls.push(String(p)); void args; }),
      set: (t, p, v) => { t[p as string] = v; return true; },
    });
    return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
  };
  const tf = { scale: 1, toScreen: (p: { x: number; y: number }) => p } as unknown as Parameters<typeof drawEntity>[2];
  const layers = [{ name: 'U', visible: true, frozen: false, color: 7, linetype: 'Continuous', lineWeight: -3, plottable: true }] as unknown as Parameters<typeof drawEntity>[3];
  const lookup = (() => undefined) as unknown as Parameters<typeof drawEntity>[4];

  it('no source: frame + cross strokes, no bitmap', () => {
    const { ctx, calls } = recordingCtx();
    drawEntity(ctx, placement(), tf, layers, lookup, {});
    expect(calls).toContain('stroke');
    expect(calls).not.toContain('drawImage');
  });

  it('with a raster: the bitmap is drawn into the frame quad', () => {
    const { ctx, calls } = recordingCtx();
    const source = () => ({ definition: def({ extent: { width: 200, height: 100 } }), page: { width: 200, height: 100 }, image: { bitmap: {} as CanvasImageSource, width: 200, height: 100 } });
    drawEntity(ctx, placement(), tf, layers, lookup, { underlaySource: source });
    expect(calls).toContain('drawImage');
    expect(calls).toContain('transform');
  });

  it('with a definition but no raster: frame + label, no bitmap', () => {
    const { ctx, calls } = recordingCtx();
    const source = () => ({ definition: def() });
    drawEntity(ctx, placement(), tf, layers, lookup, { underlaySource: source });
    expect(calls).toContain('stroke');
    expect(calls).not.toContain('drawImage');
  });

  // v0.6.4 review F-E: no composition root installs a content source, so
  // the draw path joins the placement to the drawing's own definition and
  // draws the file-name label in the frame (more strokes than the bare
  // frame + cross); a dangling or mismatched placement stays label-free.
  it('no source but the drawing holds the definition: the frame carries the label', () => {
    const strokes = (style: Parameters<typeof drawEntity>[5]): number => {
      const { ctx, calls } = recordingCtx();
      drawEntity(ctx, placement(), tf, layers, lookup, style);
      expect(calls).not.toContain('drawImage');
      return calls.filter((c) => c === 'stroke').length;
    };
    const bare = strokes({});
    const labelled = strokes({ underlayDefinitions: { 'underlaydef:41': def() } });
    const viaSource = strokes({ underlaySource: () => ({ definition: def() }) });
    expect(labelled).toBeGreaterThan(bare);
    expect(labelled).toBe(viaSource);
    // Dangling (no definition with that handle) and a mismatched handle: bare frame + cross.
    expect(strokes({ underlayDefinitions: { 'underlaydef:99': { ...def(), id: 'underlaydef:99', handle: '99' } } })).toBe(bare);
    expect(underlayDefinitionContent(placement(), { 'underlaydef:41': def() })?.definition.handle).toBe('41');
    expect(underlayDefinitionContent(placement(), undefined)).toBeUndefined();
    expect(underlayDefinitionContent(placement({ definitionHandle: '' }), { 'underlaydef:41': def() })).toBeUndefined();
  });
});

describe('plugin API stated rule (C4)', () => {
  it('normalizeEntity refuses plugin-authored underlay placements under the stated rule', () => {
    const state = new Drawing().snapshot;
    expect(() => normalizeEntity({ type: 'underlay', kind: 'pdf', definitionHandle: '41', position: { x: 0, y: 0 } }, state, 'add')).toThrow(/cannot be authored/);
  });
});
